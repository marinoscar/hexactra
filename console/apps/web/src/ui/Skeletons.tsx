import { Card, CardContent, Skeleton, Stack } from '@mui/material';

export interface SkeletonProps {
  /** How many placeholder rows or cards; default 3. */
  rows?: number;
}

/** Placeholder rows while a list's first load is pending. */
export function ListSkeleton({ rows = 3 }: SkeletonProps) {
  return (
    <Stack spacing={1} role="status" aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} variant="rounded" height={48} />
      ))}
    </Stack>
  );
}

/** Placeholder cards while a card list's first load is pending. */
export function CardSkeleton({ rows = 3 }: SkeletonProps) {
  return (
    <Stack spacing={2} role="status" aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} variant="outlined">
          <CardContent>
            <Skeleton variant="text" width="40%" sx={{ fontSize: '1.25rem' }} />
            <Skeleton variant="text" width="90%" />
            <Skeleton variant="text" width="60%" />
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}
