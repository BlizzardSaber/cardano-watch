# Security

Cardano Watch is a watch-only application. It must never ask for a seed phrase,
private key or hardware-wallet approval. Descriptors and account public keys do
not authorize spending, but they reveal the wallet's derived addresses, balances
and transaction history and should still be treated as private financial data.

Before relying on a receive address for a large deposit, reproduce the address
independently from the same descriptor and test with a small transfer. Koios,
Blockfrost, token metadata and fiat prices are untrusted display data.

Please report suspected vulnerabilities privately through GitHub Security
Advisories. Do not include real descriptors, account public keys, addresses,
API keys or transaction files in a public issue.
