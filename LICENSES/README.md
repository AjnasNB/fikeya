# Fikeya distribution license map

Fikeya is a mixed-license open-source distribution. A component's nearest license declaration controls that component; this map does not replace any license text or third-party notice.

| Scope | License | Full text |
| --- | --- | --- |
| Code OSS foundation and retained upstream files | MIT and the licenses recorded by upstream | [`../LICENSE.txt`](../LICENSE.txt) and [`../ThirdPartyNotices.txt`](../ThirdPartyNotices.txt) |
| Fikeya-owned runtime, agent core, desktop extension, product integration, setup, and site code, unless a file states otherwise | GNU AGPL-3.0-or-later | [`AGPL-3.0-or-later.txt`](AGPL-3.0-or-later.txt) |
| Public Fikeya protocol package and schemas | Apache-2.0 | [`Apache-2.0.txt`](Apache-2.0.txt) and [`../packages/fikeya-protocol/LICENSE`](../packages/fikeya-protocol/LICENSE) |
| Qarinah sidecar adapter | Apache-2.0 | [`Apache-2.0.txt`](Apache-2.0.txt) and [`../integrations/qarinah-sidecar/LICENSE`](../integrations/qarinah-sidecar/LICENSE) |
| External browser and crawler tools selected through reviewed presets | Their respective upstream licenses; they are not bundled by the presets | [`../integrations/tool-presets/THIRD_PARTY_NOTICES.md`](../integrations/tool-presets/THIRD_PARTY_NOTICES.md) |

The root `package.json` deliberately retains the private `code-oss-dev` source-workspace identity. It is not the Fikeya distribution manifest and must not be published to npm. [`../fikeya-distribution.json`](../fikeya-distribution.json) records the Fikeya product identity and license scopes used by release metadata and software bills of materials.

Redistributors must preserve every applicable copyright notice, license text, source-offer obligation, and third-party notice. The Microsoft Visual Studio Code product name, logos, Marketplace, and proprietary services are not part of Fikeya.
