# Production Azure OpenAI boundary

This template creates a new production boundary; it does not mutate the shared development resource.

Security defaults are fail closed:

- public network access disabled;
- private endpoint plus `privatelink.openai.azure.com` DNS;
- local key authentication disabled;
- Microsoft Entra ID only;
- optional inference-only `Cognitive Services OpenAI User` assignment;
- system-assigned managed identity;
- pinned model version and deployment capacity.

Validate before deployment:

```powershell
az bicep build --file infra/azure/main.bicep
az deployment group what-if --resource-group <production-resource-group> --template-file infra/azure/main.bicep --parameters accountName=<globally-unique-name> operatorPrincipalId=<workload-object-id>
```

Deploy only after the `what-if` output has been reviewed:

```powershell
az deployment group create --resource-group <production-resource-group> --template-file infra/azure/main.bicep --parameters accountName=<globally-unique-name> operatorPrincipalId=<workload-object-id>
```

The client must run on a device or workload with network reachability to the virtual network and private DNS zone. Configure Fikeya with the output endpoint, output deployment name, and `entra-id` authentication. Do not copy account keys into Fikeya.

For the current beta, `gpt-5.4-mini` is the conservative default because the existing development deployment already uses it and Fikeya's adapter has been exercised against that deployment. Benchmark `gpt-5.6-luna` separately before changing the default; it is newer and may require quota, and reasoning plus tool calling should use the Responses API.
