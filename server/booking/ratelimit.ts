/**
 * Limitation de débit en mémoire, par clé (adresse IP), à fenêtre fixe.
 * La mémoire est bornée : au-delà de maxKeys, les fenêtres expirées puis les
 * plus anciennes sont retirées.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 5000,
  ) {}

  /** Compte une requête. ok faux : limite atteinte, réessayer dans retryAfterSec secondes. */
  take(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.hits.size >= this.maxKeys) this.evict(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      // Réinsertion : la clé redevient la plus récente.
      this.hits.delete(key);
      this.hits.set(key, entry);
    }
    if (entry.count >= this.max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    entry.count++;
    return { ok: true, retryAfterSec: 0 };
  }

  /** Vrai si la limite est atteinte pour cette clé, sans rien compter. */
  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    return Boolean(entry && entry.resetAt > now && entry.count >= this.max);
  }

  private evict(now: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
    // Toujours plein : on retire les plus anciennes (ordre d'insertion).
    const excess = this.hits.size - this.maxKeys + 1;
    if (excess > 0) {
      let removed = 0;
      for (const key of this.hits.keys()) {
        this.hits.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * Clé de limitation pour une adresse : l'IPv4 telle quelle, l'IPv6 réduite à son
 * préfixe /64 (un même abonné dispose de tout le /64).
 */
export function rateKey(address: string): string {
  let ip = address.trim().toLowerCase().slice(0, 64);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  ip = ip.split('%')[0];
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
