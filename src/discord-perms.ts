export type GuildChannel = {
  id: string;
  name: string;
  type: number;
  position?: number;
  permission_overwrites?: { id: string; allow?: string; deny?: string }[];
};
export type GuildRole = { id: string; permissions?: string };

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

/**
 * Whether a member holding only @everyone (the role whose id is the guild's) may see the channel, as Discord computes
 * it: the role's server permissions (Administrator sees everything), then the channel's @everyone overwrite removes its
 * deny bits and adds its allow bits. Other roles' and members' overwrites do not apply to such a member. A guild whose
 * role list has no @everyone counts as seeing nothing, so an unknown permission never makes a channel public.
 */
export function everyoneSees(c: GuildChannel, guild: string, roles: GuildRole[]): boolean {
  const base = BigInt(roles.find((r) => r.id === guild)?.permissions ?? "0");
  if ((base & ADMINISTRATOR) !== 0n) return true;
  const o = (c.permission_overwrites ?? []).find((p) => p.id === guild);
  const perms = (base & ~BigInt(o?.deny ?? "0")) | BigInt(o?.allow ?? "0");
  return (perms & VIEW_CHANNEL) !== 0n;
}
