# Fikeya code-signing policy

Fikeya publishes installable artifacts only from the protected `AjnasNB/fikeya` repository. Release artifacts are built by GitHub Actions from a reviewed tag, hashed, attached to a GitHub release, and accompanied by a machine-readable verification manifest and provenance.

## Current signing status

Fikeya has applied for the SignPath Foundation open-source program. No artifact is described as SignPath-signed until the application is accepted and the published verification manifest reports a valid signature. The current beta-1 Windows installer is unsigned and can display an unknown-publisher warning.

After acceptance, eligible release pages and download pages will carry the required attribution:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

## Release roles

- **Authors:** repository contributors who propose source changes through pull requests.
- **Reviewers:** maintainers with write access who review the exact release diff and required checks. The current independent reviewer is [cognifyrdotco](https://github.com/cognifyrdotco).
- **Approvers:** the project maintainer, [Ajnas N B](https://github.com/AjnasNB), manually approves each signing request only after the protected release workflow, required review, tests, provenance, and artifact inspection pass.

The author of a change cannot satisfy the required independent pull-request review for that same change. Signing approval is separate from source review and is never automatic.

## Build and verification controls

1. A release starts from a protected, signed Git tag that resolves to reviewed source.
2. GitHub Actions builds the Windows installer and supporting packages from that revision.
3. The final unsigned artifact is submitted to the configured signing service. Signing is never performed on a developer workstation.
4. A maintainer manually approves the exact signing request after reviewing its source revision, workflow run, and artifact identity.
5. The signed artifact is verified before checksums, provenance, and the release manifest are generated.
6. A release fails closed if the signature, timestamp, source revision, digest, or manifest does not agree.

Fikeya signs only its own release artifacts. Signing credentials and certificate material are never stored in the repository.

## Privacy and network behavior

Fikeya does not send telemetry by default. Project content, conversation content, provider credentials, and Qarinah memory stay local unless the user explicitly configures a model provider and confirms a network-backed turn. Provider credentials are stored in the operating-system credential vault. The selected provider receives only the bounded request that the user authorizes for that turn and applies its own privacy terms.

See the public [Fikeya privacy policy](https://fikeya.com/privacy/) for retention, deletion, provider-transfer, and contact details.

## Updates and removal

Fikeya does not silently install an unsigned update. The Desktop update feed remains disabled until a signed release manifest can be verified. Users can remove the VS Code extension through the host extension manager, uninstall Fikeya Desktop through the operating system, and delete local Fikeya/Qarinah state from the project after exporting any evidence they want to retain.

