import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Fleet default: no R2 incremental cache (pages are static or dynamic;
// add r2IncrementalCache only if ISR behavior is observed to need it).
export default defineCloudflareConfig({});
