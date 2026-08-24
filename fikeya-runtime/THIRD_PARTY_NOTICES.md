# Third-party notices

Fikeya Runtime is an independently authored component. It does not copy source
from the surrounding Code OSS workbench or from external agent projects.

Runtime dependencies:

- [keyring](https://github.com/jaraco/keyring), used only to access the
  operating system credential store. Its own license applies.
- [Azure Identity for Python](https://github.com/Azure/azure-sdk-for-python), an
  optional dependency used to obtain short-lived Entra ID tokens through the
  standard developer and workload credential chain. Its own license applies.
- [Qarinah](https://github.com/AjnasNB/qarinah), an optional separately
  installed command-line integration. Fikeya invokes its public CLI as a child
  process and does not bundle its source or retained content.

Provider names identify compatible public APIs. They do not imply endorsement
or redistribution of a provider SDK.
