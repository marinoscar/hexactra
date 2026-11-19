// The owner's default for the "sign in with my saved logins" switch of a new task or chat (E37.3, #592): their user
// setting `secrets.defaultUseSavedLogins`, off unless they turned it on. Read straight from the settings row so the
// tasks and chat modules do not depend on the optional secrets module; a failed read is "off".
import type { PrismaService } from '../prisma/prisma.service';
import { secretsDefaultUseSavedLoginsOf } from './secrets.settings';

export async function ownerDefaultUseSavedLogins(prisma: Pick<PrismaService, 'userSettings'>, userId: string): Promise<boolean> {
  try {
    const row = await prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return secretsDefaultUseSavedLoginsOf(row?.value);
  } catch {
    return false;
  }
}
