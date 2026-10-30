/** Domain-separated proof that a job came from this Worker's Maven queue. */
export const MAVEN_JOB_SIGNATURE_HEADER = "x-oasis-maven-job-signature";
export const MAVEN_JOB_TIMESTAMP_HEADER = "x-oasis-maven-job-timestamp";
export const MAVEN_JOB_SIGNATURE_MAX_AGE_SEC = 24 * 60 * 60;

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signMavenPublishJob(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`oasis-maven-publish-job.v1:${timestamp}:${body}`),
  );
  return `mpj1=${hex(mac)}`;
}

function sameFixedString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyMavenPublishJob(input: {
  secret: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs: number;
}): Promise<boolean> {
  if (!input.secret || !input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp)) return false;
  if (Math.abs(Math.floor(input.nowMs / 1000) - Number(input.timestamp)) > MAVEN_JOB_SIGNATURE_MAX_AGE_SEC) return false;
  return sameFixedString(
    await signMavenPublishJob(input.secret, input.timestamp, input.body),
    input.signature,
  );
}
