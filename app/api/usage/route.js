// GET /api/usage — powers the dashboard meter and the builder's allowance pill.
import { handler, requireUser } from '@/lib/auth';
import { getUsageSnapshot } from '@/lib/usage';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  return Response.json(await getUsageSnapshot(admin, profile));
});
