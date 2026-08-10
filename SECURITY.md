# Security

Do not commit API keys, access tokens, pairing codes, credentials, private keys, connection strings, runtime databases, customer workbooks, or local acceptance evidence.

Use environment variables or the product's protected credential store for local configuration. Keep `.env` files untracked; `.env.example` must contain placeholders only.

Report a suspected credential exposure privately to the repository owner. Do not open a public issue containing a secret.
