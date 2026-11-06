import { redirect } from "next/navigation";

type SearchValue = string | string[] | undefined;

/** Keep old campaign links working after the canonical offer slug became /protocols. */
export default async function LegacyProtocolRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, SearchValue>>;
}) {
  const input = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  redirect(`/f/oasis-ai-cc/protocols${suffix ? `?${suffix}` : ""}`);
}
