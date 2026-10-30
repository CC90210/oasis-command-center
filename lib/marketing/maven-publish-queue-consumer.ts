/** Worker-level Queue consumer: sign and hand one Maven job to Next in-process. */
import {
  MAVEN_JOB_SIGNATURE_HEADER,
  MAVEN_JOB_TIMESTAMP_HEADER,
  signMavenPublishJob,
} from "./maven-publish-job-signature";

export const MAVEN_PUBLISH_JOBS_PATH = "/api/internal/maven-publish/jobs";
export const MAVEN_INTERNAL_ORIGIN = "https://oasis-internal.invalid";

export type MavenQueueMessage = { body: unknown; ack(): void; retry(): void };
export type MavenQueueBatch = { queue: string; messages: readonly MavenQueueMessage[] };

export type MavenQueueEnv = {
  OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET?: string;
  PUBLIC_APP_URL?: string;
};

export async function consumeMavenPublishJobs(
  batch: MavenQueueBatch,
  env: MavenQueueEnv,
  appFetch: (request: Request) => Promise<Response>,
  nowMs: () => number = Date.now,
): Promise<{ acked: number; retried: number }> {
  const secret = String(env.OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET ?? "").trim();
  let acked = 0;
  let retried = 0;
  let origin = MAVEN_INTERNAL_ORIGIN;
  try {
    if (env.PUBLIC_APP_URL) origin = new URL(env.PUBLIC_APP_URL).origin;
  } catch {
    console.error("[maven-publish.queue] PUBLIC_APP_URL is invalid; using the internal origin");
  }
  if (!secret) {
    console.error("[maven-publish.queue] signing secret is unset; retrying every message");
    for (const message of batch.messages) {
      message.retry();
      retried += 1;
    }
    return { acked, retried };
  }
  for (const message of batch.messages) {
    const body = JSON.stringify(message.body);
    const timestamp = String(Math.floor(nowMs() / 1000));
    try {
      const response = await appFetch(
        new Request(`${origin}${MAVEN_PUBLISH_JOBS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [MAVEN_JOB_TIMESTAMP_HEADER]: timestamp,
            [MAVEN_JOB_SIGNATURE_HEADER]: await signMavenPublishJob(secret, timestamp, body),
          },
          body,
        }),
      );
      if (response.ok) {
        message.ack();
        acked += 1;
      } else {
        console.error("[maven-publish.queue] job incomplete; retrying", { status: response.status });
        message.retry();
        retried += 1;
      }
    } catch (error) {
      console.error(
        "[maven-publish.queue] job threw; retrying",
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
      retried += 1;
    }
  }
  return { acked, retried };
}
