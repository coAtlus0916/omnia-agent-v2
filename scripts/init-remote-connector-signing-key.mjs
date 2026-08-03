import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const signingRoot = path.join(os.homedir(), '.omnia-agent-v5', 'signing');
const privateKeyPath = path.join(signingRoot, 'remote-connector-ed25519-private.pem');
const publicKeyPath = path.join(signingRoot, 'remote-connector-ed25519-public.pem');

fs.mkdirSync(signingRoot, { recursive: true, mode: 0o700 });

if (!fs.existsSync(privateKeyPath)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600, flag: 'wx' }
  );
  fs.writeFileSync(
    publicKeyPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o644, flag: 'wx' }
  );
  console.log(`Created a new v5 Remote Connector signing key at ${privateKeyPath}`);
} else if (!fs.existsSync(publicKeyPath)) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
  const publicKey = crypto.createPublicKey(privateKey);
  fs.writeFileSync(
    publicKeyPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o644, flag: 'wx' }
  );
  console.log(`Recovered the public key at ${publicKeyPath}`);
} else {
  console.log(`Reusing the existing v5 Remote Connector signing key at ${privateKeyPath}`);
}

console.log(fs.readFileSync(publicKeyPath, 'utf8').trim());
