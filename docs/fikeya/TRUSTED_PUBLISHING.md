# Trusted publishing for Fikeya

> **Current release status:** Fikeya `0.1.0-beta.2` is a source candidate and has not been published or Authenticode-signed. Treat every beta-2 Windows build as unsigned unless the final `release-verification.json` reports a valid trusted signature. An unsigned installer can show an unknown-publisher warning. This guide documents the approved signing paths; it does not claim that any current binary is signed.

Changing installer metadata such as `AppPublisher` does not create a trusted publisher. Trust requires a valid signature from a publicly trusted identity, applied to the final artifact and verified before release.

## Practical path from India

Azure Artifact Signing Public Trust does not currently onboard an India-based individual or organization. Use one of these available paths instead:

| Path | Availability and cost | What it provides |
| --- | --- | --- |
| Microsoft Store MSIX | Worldwide; Store signing is free | Microsoft certifies and re-signs an MSIX package. This is the simplest immediate public-distribution path. The Store does **not** re-sign an MSI or EXE submission; those installers must already be Authenticode-signed. |
| SignPath Foundation | Free for qualifying open-source projects | Managed OV-level code signing after the project is accepted. Review the [SignPath Foundation program](https://signpath.org/) and its eligibility requirements. |
| Commercial OV certificate | Worldwide; Microsoft estimates about USD 150-300 per year | Traditional public Authenticode signing through a trusted certificate authority. Since June 2023, OV private keys must be held in an HSM, hardware token, or an equivalent managed service. |

Microsoft documents all three options in its [Windows code-signing guide](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options). For Fikeya, Microsoft Store MSIX is the lowest-friction immediate option; SignPath Foundation is worth applying to in parallel. A commercial OV certificate is the direct-download fallback.

The project's public release roles, manual approval boundary, privacy disclosure, update rules, and SignPath attribution are defined in the [Fikeya code-signing policy](CODE_SIGNING_POLICY.md). The attribution is explicitly conditional until SignPath Foundation accepts the application and a verification manifest reports a valid signature.

## Azure Artifact Signing eligibility

[Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview) is Microsoft's managed Authenticode service, formerly called Trusted Signing. Public Trust onboarding currently has both subscription and identity-location requirements:

- The Azure subscription must be paid, either pay-as-you-go or an enterprise agreement. Free, trial, and sponsored subscriptions are not supported. See the [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq#can-i-use-artifact-signing-with-a-free-trial-or-sponsored-azure-subscription).
- Organizations must be legally established in the United States, Canada, the European Union, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, or Israel.
- Individual developers must be located in the United States or Canada.
- India is not currently on either Public Trust list. Creating the Azure resource in a supported Azure region does not change the publisher's identity-location eligibility.
- Private Trust profiles are for environments where the operator distributes its own trust policy. They are not a substitute for Public Trust on general consumer Windows devices.

The service-specific [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart#prerequisites) is the authoritative eligibility source and should be rechecked before purchasing or creating an account.

### Current Azure pricing

Pricing checked on 25 August 2026:

| Tier | Monthly account price | Included signatures | Overage | Profiles |
| --- | ---: | ---: | ---: | ---: |
| Basic | USD 9.99 | 5,000 per month | USD 0.005 each | 1 of each available type |
| Premium | USD 99.99 | 100,000 per month | USD 0.005 each | 10 of each available type |

See Microsoft's [current product pricing](https://azure.microsoft.com/en-us/products/artifact-signing) and [SKU details](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku). Do not create a paid account merely to test eligibility; complete the legal and subscription preflight first.

## Azure setup when the publisher becomes eligible

### 1. Prepare the verified identity

1. Use a Microsoft Entra tenant and a paid supported Azure subscription.
2. Ensure the Azure billing legal name and address exactly match the identity to be validated. Artifact Signing does not permit a custom certificate Common Name or Organization value.
3. For an organization, prepare current registration records, business identifier, public website, organization-domain email addresses, and the authorized representative's government ID.
4. Allow 1-20 business days for public identity validation. Identity validation is completed in the Azure portal, not through the CLI.

### 2. Register the service and create the account

Install the current Azure CLI, then run:

```powershell
az login
az account set -s <subscription-id>
az provider register --namespace Microsoft.CodeSigning
az provider show --namespace Microsoft.CodeSigning
az extension add --name artifact-signing
az group create --name fikeya-signing-rg --location EastUS
az artifact-signing create `
  --name <globally-unique-account-name> `
  --location eastus `
  --resource-group fikeya-signing-rg `
  --sku Basic
```

The account name must be globally unique. Choose a [supported Artifact Signing region and matching endpoint](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart#azure-regions-that-support-artifact-signing).

### 3. Assign minimum roles and validate the identity

1. Grant the human operator subscription `Reader` plus `Artifact Signing Identity Verifier` for portal identity validation.
2. The person creating the account and certificate profile needs at least `Contributor`.
3. In the Azure portal, open the Artifact Signing account, select **Identity validations**, and submit a **Public** validation for the real publisher.
4. After validation completes, copy its identity-validation ID.

The CI identity needs only `Artifact Signing Certificate Profile Signer` scoped to the certificate profile. Microsoft's [role guide](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles) includes the exact RBAC scope format.

### 4. Create the Public Trust profile

```powershell
az artifact-signing certificate-profile create `
  --resource-group fikeya-signing-rg `
  --account-name <account-name> `
  --name FikeyaPublic `
  --profile-type PublicTrust `
  --identity-validation-id <identity-validation-id>
```

Use `PublicTrust`, not `PublicTrustTest`, for a public release.

### 5. Connect GitHub Actions without a client secret

1. Create a Microsoft Entra application/service principal.
2. Add a GitHub federated identity credential restricted to `AjnasNB/fikeya` and the protected release environment or release tags.
3. Grant that service principal `Artifact Signing Certificate Profile Signer` on `FikeyaPublic`.
4. Set these GitHub secrets:
   - `FIKEYA_AZURE_CLIENT_ID`
   - `FIKEYA_AZURE_TENANT_ID`
   - `FIKEYA_AZURE_SUBSCRIPTION_ID`
5. Set these GitHub variables:
   - `FIKEYA_AZURE_ARTIFACT_SIGNING_ENABLED=true`
   - `FIKEYA_AZURE_ARTIFACT_SIGNING_ENDPOINT=https://eus.codesigning.azure.net/` for an East US account
   - `FIKEYA_AZURE_ARTIFACT_SIGNING_ACCOUNT=<account-name>`
   - `FIKEYA_AZURE_ARTIFACT_SIGNING_PROFILE=FikeyaPublic`

The repository's release workflow already authenticates through GitHub OIDC with `azure/login` and signs through Microsoft's [`azure/artifact-signing-action`](https://github.com/Azure/artifact-signing-action). Keep `id-token: write`, scope the federated credential narrowly, and never add a long-lived Azure client secret.

### 6. Test and verify locally

Install Microsoft's supported client tools:

```powershell
winget install -e --id Microsoft.Azure.ArtifactSigningClientTools
```

Create `metadata.json` outside the repository:

```json
{
  "Endpoint": "https://eus.codesigning.azure.net/",
  "CodeSigningAccountName": "<account-name>",
  "CertificateProfileName": "FikeyaPublic"
}
```

After authenticating with an identity that has the Profile Signer role, sign the final artifact with the matching x64 SignTool and Artifact Signing library:

```powershell
& "<SDK-bin>\x64\signtool.exe" sign /v /debug /fd SHA256 `
  /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
  /dlib "<Artifact-Signing-dlib>\x64\Azure.CodeSigning.Dlib.dll" `
  /dmdf "<path>\metadata.json" "<path>\FikeyaSetup.exe"

& "<SDK-bin>\x64\signtool.exe" verify /v /debug /pa "<path>\FikeyaSetup.exe"
```

Timestamping is mandatory because Artifact Signing certificates have a three-day validity. Sign the packaged EXE, DLL, or MSIX first, verify it, and only then generate checksums, provenance, and release uploads. Never modify a signed artifact.

Microsoft maintains the current [SignTool prerequisites and commands](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations#set-up-signtool-to-use-artifact-signing).

## SmartScreen is a separate reputation system

A valid Authenticode signature lets Windows verify the legal publisher and detect tampering. It does **not** guarantee that a new download will immediately avoid Microsoft Defender SmartScreen. New file hashes and new publishers can still receive an "unrecognized app" prompt while reputation accumulates. Signing every release consistently helps preserve publisher reputation, but no signing provider should be described as an instant SmartScreen bypass.

See Microsoft's [SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation). The exception is the Microsoft Store MSIX path, where Microsoft states that certified Store delivery avoids the download warning.

## macOS is a separate trust pipeline

Windows Authenticode and Azure Artifact Signing do not sign or notarize macOS applications. Direct macOS distribution requires a separate Apple workflow:

1. Enroll the publishing person or legal entity in the [Apple Developer Program](https://developer.apple.com/programs/enroll/) (normally USD 99 per membership year).
2. Sign the app with a **Developer ID Application** certificate and sign a PKG installer, if used, with **Developer ID Installer**.
3. Enable Hardened Runtime and a secure timestamp.
4. Submit the ZIP, PKG, or DMG to Apple's notary service with `xcrun notarytool`.
5. Staple the accepted ticket with `xcrun stapler` and verify the result with `spctl` before release.

Apple's [Developer ID guidance](https://developer.apple.com/support/developer-id/) and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) are the source of truth. A Windows signing certificate cannot replace Apple Developer ID membership, signing, and notarization.
