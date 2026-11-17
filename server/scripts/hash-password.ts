// Usage : npm run hash-password -- "mon mot de passe"
// (ou sans argument : le mot de passe est lu sur l'entrée standard)
import { hashPassword } from '../password.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const pw = process.argv[2] ?? (await readStdin());
if (!pw || pw.length < 10) {
  console.error('Choisis un mot de passe d’au moins 10 caractères.');
  process.exit(1);
}
console.log(`ALFRED_PASSWORD_HASH=${await hashPassword(pw)}`);
