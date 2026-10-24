import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Encrypts secrets (the Slack user token) before they reach the database. The key comes from
 * `UC_SECRET_KEY`, else a key file created next to the data directory (readable only by the user),
 * else, for in-memory databases, a throwaway key for this process.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromEnv(dataDir: string | undefined, env: NodeJS.ProcessEnv = process.env): SecretBox {
    if (env.UC_SECRET_KEY) return new SecretBox(createHash('sha256').update(env.UC_SECRET_KEY).digest());
    if (!dataDir) return new SecretBox(randomBytes(32));
    const file = join(dirname(dataDir), 'secret.key');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    chmodSync(file, 0o600);
    return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
  }

  static ephemeral() {
    return new SecretBox(randomBytes(32));
  }

  /** AES-256-GCM; output is `v1.<iv>.<tag>.<ciphertext>` in base64url. */
  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
