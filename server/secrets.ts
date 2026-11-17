import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chiffrement des secrets au repos (mots de passe SMTP et CalDAV enregistrés depuis l'app).
 *
 * AES-256-GCM, un nonce aléatoire de 12 octets par valeur, et le nom du champ en données
 * authentifiées : une valeur chiffrée recopiée dans un autre champ ne se déchiffre pas.
 * Format : « v1:<nonce>:<chiffré + étiquette> », en base64url.
 */

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_FILE = 'secret.key';

export type SecretKeySource = 'env' | 'file' | 'memory' | 'none';

/** La clé est absente ou inutilisable : rien ne peut être chiffré. Le message est affichable tel quel. */
export class SecretKeyError extends Error {}

export interface SecretKeyStatus {
  source: SecretKeySource;
  /** Problème à afficher dans l'admin (jamais la clé elle-même), ou null. */
  problem: string | null;
}

/** Chiffre et déchiffre avec une clé donnée. */
export function sealWith(key: Buffer, field: string, plaintext: string): string {
  if (key.length !== KEY_BYTES) throw new SecretKeyError('Clé de chiffrement invalide');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`alfred:${field}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}:${nonce.toString('base64url')}:${body.toString('base64url')}`;
}

/** null : valeur altérée, mauvaise clé, autre champ ou format inconnu. Ne lève jamais. */
export function openWith(key: Buffer, field: string, sealed: string): string | null {
  try {
    const [version, nonceText, bodyText, extra] = sealed.split(':');
    if (version !== VERSION || !nonceText || !bodyText || extra !== undefined || key.length !== KEY_BYTES) return null;
    const nonce = Buffer.from(nonceText, 'base64url');
    const body = Buffer.from(bodyText, 'base64url');
    if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(`alfred:${field}`, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** ALFRED_SECRET_KEY : 32 octets en hexadécimal (64 caractères) ou en base64. */
export function parseSecretKey(value: string): Buffer | null {
  const text = value.trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const key = Buffer.from(text.replace(/=$/, ''), 'base64url');
    if (key.length === KEY_BYTES) return key;
  }
  return null;
}

/** Message pour un fichier de clé présent mais illisible ; le cas des droits (après une restauration) est nommé. */
export function keyReadProblem(code: string | undefined): string {
  if (code === 'EACCES' || code === 'EPERM') {
    return `Le fichier de clé (${KEY_FILE}) existe, mais Alfred n’a pas le droit de le lire : ses droits ou son propriétaire ont changé, par exemple après une restauration. `
      + 'Rends le dossier de données à l’utilisateur du conteneur (commande « chown » de la section Sauvegarde de docs/DEPLOIEMENT.md), puis redémarre Alfred.';
  }
  return `Le fichier de clé (${KEY_FILE}) ne peut pas être lu.`;
}

export interface SecretBoxOptions {
  /** Dossier de données ; ':memory:' : clé en mémoire seulement (tests). */
  dataDir: string;
  /** Valeur de ALFRED_SECRET_KEY, si elle est définie. */
  envKey?: string;
}

/**
 * Coffre des secrets : trouve la clé (variable d'environnement, sinon fichier dans le dossier
 * de données, créé au premier chiffrement) et ne lève jamais à la lecture. La clé n'est ni
 * journalisée ni renvoyée par aucune méthode.
 */
export class SecretBox {
  private key: Buffer | null = null;
  private source: SecretKeySource = 'none';
  private problem: string | null = null;
  private readonly keyPath: string | null;

  constructor(private readonly opts: SecretBoxOptions) {
    this.keyPath = opts.dataDir === ':memory:' ? null : join(opts.dataDir, KEY_FILE);
    this.load();
  }

  private load(): void {
    this.key = null;
    this.source = 'none';
    this.problem = null;
    const env = this.opts.envKey?.trim();
    if (env) {
      const key = parseSecretKey(env);
      if (key) {
        this.key = key;
        this.source = 'env';
      } else {
        this.problem = 'ALFRED_SECRET_KEY est invalide : il faut 32 octets en hexadécimal (64 caractères) ou en base64.';
      }
      return;
    }
    if (!this.keyPath) {
      this.key = randomBytes(KEY_BYTES);
      this.source = 'memory';
      return;
    }
    try {
      const key = readFileSync(this.keyPath);
      if (key.length === KEY_BYTES) {
        this.key = key;
        this.source = 'file';
        // Un fichier de clé lisible par d'autres comptes est resserré, au mieux.
        try {
          if ((statSync(this.keyPath).mode & 0o077) !== 0) this.problem = `Le fichier de clé (${KEY_FILE}) est lisible par d’autres comptes du serveur : passe-le en mode 600.`;
        } catch { /* sans importance */ }
      } else {
        this.problem = `Le fichier de clé (${KEY_FILE}) est illisible : il devrait faire ${KEY_BYTES} octets.`;
      }
    } catch (err) {
      // Absent : il sera créé au premier secret enregistré.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.problem = keyReadProblem(code);
    }
  }

  status(): SecretKeyStatus {
    return { source: this.source, problem: this.problem };
  }

  /** Crée le fichier de clé : écrit à part en mode 600, puis lié sous son nom définitif (jamais à moitié écrit, jamais écrasé). */
  private createKeyFile(): Buffer {
    const path = this.keyPath!;
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const key = randomBytes(KEY_BYTES);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
      return key;
    } catch (err) {
      // Créé entre-temps par un autre appel : c'est sa clé qui fait foi.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readFileSync(path);
      if (existing.length !== KEY_BYTES) throw new SecretKeyError(`Le fichier de clé (${KEY_FILE}) est illisible.`);
      return existing;
    } finally {
      try { unlinkSync(tmp); } catch { /* déjà retiré */ }
    }
  }

  private keyForWriting(): Buffer {
    if (this.key) return this.key;
    if (this.problem || !this.keyPath) throw new SecretKeyError(this.problem ?? 'Aucune clé de chiffrement disponible.');
    try {
      this.key = this.createKeyFile();
      this.source = 'file';
      return this.key;
    } catch (err) {
      if (err instanceof SecretKeyError) throw err;
      throw new SecretKeyError(`Le fichier de clé (${KEY_FILE}) n’a pas pu être créé dans le dossier de données.`);
    }
  }

  /** Chiffre une valeur pour un champ. Lève SecretKeyError si aucune clé n'est utilisable. */
  seal(field: string, plaintext: string): string {
    return sealWith(this.keyForWriting(), field, plaintext);
  }

  /** Déchiffre ; null si la clé manque ou ne correspond plus (le secret est alors à ressaisir). */
  open(field: string, sealed: string): string | null {
    return this.key ? openWith(this.key, field, sealed) : null;
  }
}
