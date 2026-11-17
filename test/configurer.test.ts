// deploy/configurer.sh, joué avec de faux « docker », « curl » et « sleep » : rien n'est construit ni lancé.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'configurer.sh');
const HASH = 'scrypt:16384:c2Vs:ZW1wcmVpbnRl';
// Valeurs factices, au format attendu par le script (aucun vrai secret).
const FAUX_ICLOUD = ['abcd', 'efgh', 'ijkl', 'mnop'].join('-');
const FAUX_SMTP = ['valeur', 'factice', 'smtp'].join('-');

/** Lance le script dans un dossier jetable et renvoie les commandes docker qu'il a passées, dans l'ordre. */
function run(input: string, env?: string): { docker: string[]; env: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'alfred-configurer-'));
  try {
    mkdirSync(join(dir, 'deploy'));
    mkdirSync(join(dir, 'bin'));
    copyFileSync(SCRIPT, join(dir, 'deploy', 'configurer.sh'));
    const log = join(dir, 'docker.log');
    const fake = (name: string, body: string) => {
      writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(dir, 'bin', name), 0o755);
    };
    // « image inspect » réussit : une image d'une version précédente existe déjà sur le serveur.
    fake('docker', `echo "$*" >> "${log}"\nif [[ "$1" == run ]]; then cat >/dev/null; echo "ALFRED_PASSWORD_HASH=${HASH}"; fi\nexit 0`);
    fake('curl', 'exit 0');
    fake('sleep', 'exit 0');
    if (env !== undefined) writeFileSync(join(dir, '.env'), env);
    const output = execFileSync('bash', [join(dir, 'deploy', 'configurer.sh')], {
      input, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      docker: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
      env: readFileSync(join(dir, '.env'), 'utf8'),
      output,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('deploy/configurer.sh', () => {
  it('relancé sur une installation existante, reconstruit l’image avant de redémarrer et garde les secrets', () => {
    const existing = [
      `ALFRED_PASSWORD_HASH=${HASH}`, 'CALDAV_URL=https://caldav.icloud.com', "CALDAV_USERNAME='antoine@example.org'",
      `CALDAV_PASSWORD='${FAUX_ICLOUD}'`, 'CALDAV_SYNC_INTERVAL=120', 'ALFRED_TIMEZONE=Europe/Zurich', '',
    ].join('\n');
    // Garder iCloud, garder le mot de passe, puis identifiant et mot de passe SMTP.
    const { docker, env, output } = run(`\n\ninfo@example.org\n${FAUX_SMTP}\n`, existing);
    // Après un « git pull », c'est la nouvelle version qui doit démarrer : construction, puis démarrage.
    const build = docker.indexOf('compose -f deploy/docker-compose.yml build');
    const up = docker.findIndex((line) => line.startsWith('compose -f deploy/docker-compose.yml up -d'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(build);
    expect(docker[up]).toBe('compose -f deploy/docker-compose.yml up -d --build');
    // Les secrets existants sont conservés tels quels, le SMTP est ajouté, rien n'est affiché.
    expect(env).toContain(`ALFRED_PASSWORD_HASH=${HASH}`);
    expect(env).toContain(`CALDAV_PASSWORD='${FAUX_ICLOUD}'`);
    expect(env).toContain("SMTP_USER='info@example.org'");
    expect(env).toContain(`SMTP_PASSWORD='${FAUX_SMTP}'`);
    expect(output).not.toContain(FAUX_ICLOUD);
    expect(output).not.toContain(FAUX_SMTP);
    expect(output).toContain('Alfred tourne');
    // Le script prévient que les réglages de l'app passent avant le .env.
    expect(output).toContain("c'est l'app qui a la priorité");
  });

  it('ne prétend pas que l’envoi est désactivé ou absent quand il peut être réglé dans l’app', () => {
    const existing = [
      `ALFRED_PASSWORD_HASH=${HASH}`, "CALDAV_USERNAME='antoine@example.org'", `CALDAV_PASSWORD='${FAUX_ICLOUD}'`,
      "SMTP_USER='info@example.org'", `SMTP_PASSWORD='${FAUX_SMTP}'`, '',
    ].join('\n');
    // Garder iCloud et le mot de passe, puis « - » : l'envoi est retiré du .env.
    const { env, output } = run('\n\n-\n\n', existing);
    expect(env).not.toContain('SMTP_USER');
    expect(output).toContain('retire l\'envoi du .env seulement');
    expect(output).toContain("envoi non configuré dans le .env");
    expect(output).toContain("s'il y est déjà réglé, il continue de fonctionner");
    expect(output).not.toContain('relance ce script pour l');
  });

  it('à la première installation, construit l’image avant de calculer l’empreinte du mot de passe', () => {
    const { docker, env } = run(`antoine@example.org\n${FAUX_ICLOUD}\nmot de passe long\nmot de passe long\n\n`);
    const build = docker.indexOf('compose -f deploy/docker-compose.yml build');
    const hash = docker.findIndex((line) => line.startsWith('run ') && line.includes('hash-password'));
    const up = docker.indexOf('compose -f deploy/docker-compose.yml up -d --build');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(hash).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(hash);
    expect(env).toContain(`ALFRED_PASSWORD_HASH=${HASH}`);
    expect(env).not.toContain('SMTP_USER');
  });
});
