# External Tool Preset Notices

The Fikeya preset files identify, but do not bundle, the following external packages.

## Cockroach Browser

- Package: `cockroach-browser`
- Reviewed preset range: `>=0.2.1 <0.3.0`
- Source: <https://github.com/AjnasNB/cockroach-browser>
- Homepage: <https://cockroachbrowser.com>
- License: GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)
- Upstream license text: <https://github.com/AjnasNB/cockroach-browser/blob/main/LICENSE>

The preset invokes an installed `cockroach-browser mcp` executable. No Cockroach Browser source, browser binary, profile, credential, or daemon token is copied into Fikeya by this directory.

## Cockroach Crawler

- Package: `cockroach-crawler`
- Reviewed preset range: `>=0.7.0 <0.8.0`
- Source: <https://github.com/AjnasNB/cockroach-crawler>
- Homepage: <https://cockroachcrawler.com>
- License: MIT
- Upstream license text: <https://github.com/AjnasNB/cockroach-crawler/blob/main/LICENSE>

The preset invokes an installed `cockroach-mcp` executable. No Cockroach Crawler source, provider credential, browser dependency, or crawl artifact is copied into Fikeya by this directory.

Each external package contains its own dependency notices. Operators and distributors must review the notice and license files shipped with the exact installed version. Fikeya's preset metadata does not replace those files and does not alter either package's license terms.
