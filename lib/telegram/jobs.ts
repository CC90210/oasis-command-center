/** Durable Telegram queue job: exact device turn, then at-most-once reply. */
import "server-only";
import type { Client } from "@libsql/client";
import { sendOasisTelegramReply, telegramReplyText, type TelegramSendResult } from "./api";
import { runOasisTelegramDeviceTurn, type TelegramDeviceTurnResult } from "./device-turn";
import {
  claimTelegramReceipt,
  finishTelegramDeliveryUnknown,
  finishTelegramSent,
  markTelegramSending,
  releaseTelegramReceipt,
  savePreparedTelegramReply,
  type TelegramReceiptPayload,
} from "./receipt-store";
import {
  NO_PAIRED_COMPUTER_REPLY,
  type OasisTelegramConfig,
  type OasisTelegramJob,
} from "./protocol";

export type TelegramJobOutcome =
  | { outcome: "sent"; telegramMessageId: number; noComputer: boolean }
  | { outcome: "duplicate"; state: string }
  | { outcome: "delivery_unknown" }
  | { outcome: "retry"; reason: string };

export type TelegramJobDeps = {
  db: Client;
  config: OasisTelegramConfig;
  now: () => Date;
  deviceTurn?: (db: Client, job: OasisTelegramJob) => Promise<TelegramDeviceTurnResult>;
  sendReply?: (input: {
    config: OasisTelegramConfig;
    job: OasisTelegramJob;
    text: string;
  }) => Promise<TelegramSendResult>;
};

function received(job: OasisTelegramJob): TelegramReceiptPayload {
  return { v: 1, job, phase: "received" };
}

function prepared(job: OasisTelegramJob, replyText: string): TelegramReceiptPayload {
  return { v: 1, job, phase: "prepared", replyText };
}

export async function runOasisTelegramJob(job: OasisTelegramJob, deps: TelegramJobDeps): Promise<TelegramJobOutcome> {
  const claim = await claimTelegramReceipt(deps.db, job, deps.now());
  if (claim.state === "done") return { outcome: "duplicate", state: claim.receipt.payload.phase };
  if (claim.state === "busy") return { outcome: "retry", reason: "receipt_busy" };
  const leaseToken = claim.leaseToken;

  let payload = claim.receipt.payload;
  if (payload.phase === "sending") {
    await finishTelegramDeliveryUnknown(
      deps.db,
      job,
      payload.replyText || "",
      deps.now(),
      "telegram_delivery_unknown_after_retry",
      leaseToken,
    );
    return { outcome: "delivery_unknown" };
  }
  if (payload.phase === "delivery_unknown" || payload.phase === "sent") {
    // Defensive repair for a payload write that committed without its status.
    await finishTelegramDeliveryUnknown(
      deps.db,
      job,
      payload.replyText || "",
      deps.now(),
      `telegram_receipt_inconsistent:${payload.phase}`,
      leaseToken,
    );
    return payload.phase === "sent"
      ? { outcome: "duplicate", state: "sent" }
      : { outcome: "delivery_unknown" };
  }

  let replyText = payload.phase === "prepared" ? payload.replyText || "" : "";
  let noComputer = false;
  if (!replyText) {
    const turn = await (deps.deviceTurn ?? runOasisTelegramDeviceTurn)(deps.db, job);
    if (turn.outcome === "retry") {
      await releaseTelegramReceipt(deps.db, job, received(job), turn.reason, leaseToken);
      return { outcome: "retry", reason: turn.reason };
    }
    if (turn.outcome === "no_computer") {
      noComputer = true;
      replyText = telegramReplyText(NO_PAIRED_COMPUTER_REPLY);
    } else {
      replyText = telegramReplyText(turn.text);
    }
    payload = await savePreparedTelegramReply(deps.db, job, replyText, leaseToken);
  } else {
    noComputer = replyText === NO_PAIRED_COMPUTER_REPLY;
  }

  await markTelegramSending(deps.db, job, replyText, leaseToken);
  const sent = await (deps.sendReply ?? sendOasisTelegramReply)({ config: deps.config, job, text: replyText });
  if (sent.outcome === "rejected") {
    await releaseTelegramReceipt(deps.db, job, prepared(job, replyText), sent.reason, leaseToken);
    return { outcome: "retry", reason: sent.reason };
  }
  if (sent.outcome === "ambiguous") {
    await finishTelegramDeliveryUnknown(deps.db, job, replyText, deps.now(), sent.reason, leaseToken);
    return { outcome: "delivery_unknown" };
  }
  await finishTelegramSent(deps.db, job, replyText, sent.messageId, deps.now(), leaseToken);
  return { outcome: "sent", telegramMessageId: sent.messageId, noComputer };
}
