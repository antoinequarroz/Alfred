// Chiffrement des secrets au repos (AES-256-GCM) et gestion de la clé.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_FILE, openWith, parseSecretKey, sealWith, SecretBox, SecretKeyError } from '../server/secrets.js';

// Valeur factice, construite pour ne ressembler à aucun vrai secret.
const VALEUR = ['valeur', 'factice', 'à', 'chiffrer', 'éàü'].join(' ');
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'alfred-secrets-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('chiffrement des secrets', () => {
  const key = randomBytes(32);

  it('fait l’aller-retour, avec un nonce différent à chaque fois', () => {
    const a = sealWith(key, 'smtp.password', VALEUR);
    const b = sealWith(key, 'smtp.password', VALEUR);
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('factice');
    expect(Buffer.from(a.split(':')[2], 'base64url').toString('latin1')).not.toContain('factice');
    expect(openWith(key, 'smtp.password', a)).toBe(VALEUR);
    expect(openWith(key, 'smtp.password', b)).toBe(VALEUR);
    expect(openWith(key, 'smtp.password', sealWith(key, 'smtp.password', ''))).toBe('');
  });

  it('détecte toute altération : chiffré, étiquette, nonce, format', () => {
    const sealed = sealWith(key, 'smtp.password', VALEUR);
    const [version, nonce, body] = sealed.split(':');
    const flip = (text: string, index: number) => {
      const bytes = Buffer.from(text, 'base64url');
      bytes[index < 0 ? bytes.length + index : index] ^= 1;
      return bytes.toString('base64url');
    };
    expect(openWith(key, 'smtp.password', `${version}:${nonce}:${flip(body, 0)}`)).toBeNull();
    expect(openWith(key, 'smtp.password', `${version}:${nonce}:${flip(body, -1)}`)).toBeNull();
    expect(openWith(key, 'smtp.password', `${version}:${flip(nonce, 0)}:${body}`)).toBeNull();
    expect(openWith(key, 'smtp.password', `v2:${nonce}:${body}`)).toBeNull();
    expect(openWith(key, 'smtp.password', `${version}:${nonce}`)).toBeNull();
    expect(openWith(key, 'smtp.password', `${sealed}:x`)).toBeNull();
    expect(openWith(key, 'smtp.password', '')).toBeNull();
    expect(openWith(key, 'smtp.password', VALEUR)).toBeNull();
    // Chiffré tronqué jusqu'à ne plus contenir d'étiquette entière.
    expect(openWith(key, 'smtp.password', `${version}:${nonce}:${Buffer.from(body, 'base64url').subarray(0, 10).toString('base64url')}`)).toBeNull();
  });

  it('refuse une autre clé', () => {
    const sealed = sealWith(key, 'smtp.password', VALEUR);
    expect(openWith(randomBytes(32), 'smtp.password', sealed)).toBeNull();
    expect(openWith(randomBytes(16), 'smtp.password', sealed)).toBeNull();
    expect(() => sealWith(randomBytes(16), 'smtp.password', VALEUR)).toThrow(SecretKeyError);
  });

  it('lie la valeur à son champ : recopiée ailleurs, elle ne se déchiffre pas', () => {
    const sealed = sealWith(key, 'smtp.password', VALEUR);
    expect(openWith(key, 'caldav.password', sealed)).toBeNull();
    expect(openWith(key, 'smtp.passwor', sealed)).toBeNull();
    expect(openWith(key, 'smtp.password', sealed)).toBe(VALEUR);
  });

  it('lit ALFRED_SECRET_KEY en hexadécimal ou en base64, et rien d’autre', () => {
    const raw = randomBytes(32);
    expect(parseSecretKey(raw.toString('hex'))?.equals(raw)).toBe(true);
    expect(parseSecretKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(parseSecretKey(` ${raw.toString('base64url')}\n`)?.equals(raw)).toBe(true);
    expect(parseSecretKey('trop-court')).toBeNull();
    expect(parseSecretKey(randomBytes(31).toString('hex'))).toBeNull();
    expect(parseSecretKey('')).toBeNull();
  });
});

describe('coffre des secrets (clé)', () => {
  it('crée le fichier de clé au premier chiffrement seulement, en mode 600, sans fichier temporaire restant', () => {
    const dir = tempDir();
    const box = new SecretBox({ dataDir: dir });
    expect(box.status()).toEqual({ source: 'none', problem: null });
    expect(box.open('smtp.password', 'v1:AAAA:BBBB')).toBeNull();
    expect(existsSync(join(dir, KEY_FILE))).toBe(false);

    const sealed = box.seal('smtp.password', VALEUR);
    const path = join(dir, KEY_FILE);
    expect(readFileSync(path)).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([KEY_FILE]);
    expect(box.status()).toEqual({ source: 'file', problem: null });
    expect(box.open('smtp.password', sealed)).toBe(VALEUR);

    // Un redémarrage relit la même clé, sans la remplacer.
    const before = readFileSync(path);
    const again = new SecretBox({ dataDir: dir });
    expect(again.open('smtp.password', sealed)).toBe(VALEUR);
    again.seal('caldav.password', VALEUR);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('n’écrase jamais une clé créée entre-temps par un autre appel', () => {
    const dir = tempDir();
    const a = new SecretBox({ dataDir: dir });
    const b = new SecretBox({ dataDir: dir });
    const sealedByA = a.seal('smtp.password', VALEUR);
    // b ne connaissait pas encore le fichier : il doit adopter la clé de a.
    const sealedByB = b.seal('smtp.password', VALEUR);
    expect(a.open('smtp.password', sealedByB)).toBe(VALEUR);
    expect(b.open('smtp.password', sealedByA)).toBe(VALEUR);
  });

  it('préfère ALFRED_SECRET_KEY et n’écrit alors aucun fichier', () => {
    const dir = tempDir();
    const env = randomBytes(32).toString('hex');
    const box = new SecretBox({ dataDir: dir, envKey: env });
    const sealed = box.seal('smtp.password', VALEUR);
    expect(box.status().source).toBe('env');
    expect(readdirSync(dir)).toEqual([]);
    expect(new SecretBox({ dataDir: dir, envKey: env }).open('smtp.password', sealed)).toBe(VALEUR);
    // Sans la variable (ou avec une autre), le secret n'est plus lisible, sans erreur.
    expect(new SecretBox({ dataDir: dir }).open('smtp.password', sealed)).toBeNull();
    expect(new SecretBox({ dataDir: dir, envKey: randomBytes(32).toString('hex') }).open('smtp.password', sealed)).toBeNull();
  });

  it('signale une clé invalide sans lever au démarrage, et refuse alors de chiffrer', () => {
    const dir = tempDir();
    const bad = new SecretBox({ dataDir: dir, envKey: 'pas-une-cle' });
    expect(bad.status().source).toBe('none');
    expect(bad.status().problem).toContain('ALFRED_SECRET_KEY');
    expect(bad.status().problem).not.toContain('pas-une-cle');
    expect(() => bad.seal('smtp.password', VALEUR)).toThrow(SecretKeyError);
    expect(readdirSync(dir)).toEqual([]);

    writeFileSync(join(dir, KEY_FILE), 'trop court');
    const corrupt = new SecretBox({ dataDir: dir });
    expect(corrupt.status().problem).toContain(KEY_FILE);
    expect(corrupt.open('smtp.password', 'v1:AAAA:BBBB')).toBeNull();
    expect(() => corrupt.seal('smtp.password', VALEUR)).toThrow(SecretKeyError);
    // Le fichier abîmé n'est pas remplacé d'office : c'est peut-être tout ce qui reste de la clé.
    expect(readFileSync(join(dir, KEY_FILE), 'utf8')).toBe('trop court');
  });

  it('ne journalise jamais la clé', () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const dir = tempDir();
    const box = new SecretBox({ dataDir: dir });
    box.seal('smtp.password', VALEUR);
    const key = readFileSync(join(dir, KEY_FILE));
    const all = lines.join('\n');
    expect(all).not.toContain(key.toString('hex'));
    expect(all).not.toContain(key.toString('base64'));
    expect(JSON.stringify(box.status())).not.toContain(key.toString('hex'));
  });

  it('en mémoire (tests), la clé ne touche pas le disque', () => {
    const box = new SecretBox({ dataDir: ':memory:' });
    expect(box.status().source).toBe('memory');
    expect(box.open('smtp.password', box.seal('smtp.password', VALEUR))).toBe(VALEUR);
  });
});
