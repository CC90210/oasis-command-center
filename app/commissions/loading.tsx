/**
 * /commissions loading skeleton. Painted the moment Commissions is clicked,
 * in the page's own shape (title, four total figures, the entries list), while
 * the server reads the numbers the page opens with. Shapes only, never words
 * or numbers: it used to be a "loading the ledger" card that named our
 * database. Same shared furniture as the Money tabs.
 */
import { SkeletonFigures, SkeletonHeader, SkeletonPage, SkeletonTable } from "@/components/founders/finances/Skeleton";

export default function CommissionsLoading() {
  return (
    <SkeletonPage>
      <SkeletonHeader action={false} />
      <SkeletonFigures count={4} />
      <SkeletonTable rows={5} />
    </SkeletonPage>
  );
}
