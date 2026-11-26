# accounts-seed-vault-extension@1.0.0-canary.1 (2026-11-26)

### Bug Fixes

- add configurable options for different encryption operations. Allow private key encryption as the default ([15d915e](https://github.com/mithiraj95/wallet-provider-extensions/commit/15d915e4eee1a343ae7aeff90dfe00b9d66fdb28))
- add watcher for logstore builds ([12d54d3](https://github.com/mithiraj95/wallet-provider-extensions/commit/12d54d3cb26df8ae4acce71dec2fa14424598d45))
- bind to core package ([d4f1e35](https://github.com/mithiraj95/wallet-provider-extensions/commit/d4f1e3563abb6d8eb4a5cd3aaf38982786a25419))
- fixup demo and listener ([dfa4d2f](https://github.com/mithiraj95/wallet-provider-extensions/commit/dfa4d2f1df6b8c4b2ae3c9fe640f08556df42a5f))
- **keystore-core:** backwards compatibility for deprecated hd-seed ([9559130](https://github.com/mithiraj95/wallet-provider-extensions/commit/9559130bf9d0bab1ad2c7fe13e9ae636be61931c))
- **keystore:** web storage support of custom shim material, prefer subtle shims over host subtle, adds tests for shim cases ([740ea85](https://github.com/mithiraj95/wallet-provider-extensions/commit/740ea85c622db9a47b9f85672926c82bce77cbd5))
- lock keystore dependencies ([c60daf7](https://github.com/mithiraj95/wallet-provider-extensions/commit/c60daf7cc096313796e8ed109acc07b286e289ad))
- rollback build optimization for log-store ([340ca78](https://github.com/mithiraj95/wallet-provider-extensions/commit/340ca78317a742cd300abd26ac0c27f1197ba225))
- skip release git commits on protected main ([46710fe](https://github.com/mithiraj95/wallet-provider-extensions/commit/46710fe34848f7dfbee565b033566583b56e9daa))
- use optional chaining for log store ([17f5b85](https://github.com/mithiraj95/wallet-provider-extensions/commit/17f5b8508f8364cf946eee5c1c7c4ebe9a1993e5))

### Features

- account store with multiple account types ([0daee80](https://github.com/mithiraj95/wallet-provider-extensions/commit/0daee803a268898c4364ada32daa1bc28ac08344))
- accounts with keystore bridge ([3e3bd65](https://github.com/mithiraj95/wallet-provider-extensions/commit/3e3bd65e3dda5655cf95bd51b973601dedebce46))
- **accounts-seed-vault-extension:** publish to npm under [@mithiraj](https://github.com/mithiraj) scope ([c44a527](https://github.com/mithiraj95/wallet-provider-extensions/commit/c44a527d9cce40162b1654e253c4ac7867acba65))
- allow passing in of log store in options ([8bd40f6](https://github.com/mithiraj95/wallet-provider-extensions/commit/8bd40f607f9b8ee0f9893e467a99ebd2f2c3a5f5))
- extractable keys and seeds ([b78f0f8](https://github.com/mithiraj95/wallet-provider-extensions/commit/b78f0f8a0acc0d3c895ae9155f56ddb4ca6f0a55))
- **keystore-core:** native PBKDF2 for deterministic-P256 ([c92e5da](https://github.com/mithiraj95/wallet-provider-extensions/commit/c92e5da9f3c6925745012dd488ef16360bd5d719))
- react-native-keystore alignment ([44a2f0f](https://github.com/mithiraj95/wallet-provider-extensions/commit/44a2f0fb6efb14e37afbafa3d7f6ab84da5b268c))
- **seed-vault:** add Seed Vault keystore and accounts bridge example ([e0455cd](https://github.com/mithiraj95/wallet-provider-extensions/commit/e0455cdb1e8854b8aedca0d2686943df540bd2ae))
- subtle shims and platform targets (node, web, react-native) ([3eb3936](https://github.com/mithiraj95/wallet-provider-extensions/commit/3eb393680886b8c982d06a0898ef76be6d40d3f3))
- web crypto fallback for keys and generic secret import ([f7481b1](https://github.com/mithiraj95/wallet-provider-extensions/commit/f7481b1dc95014c1903a4351d5fffc8c9995e31a))
