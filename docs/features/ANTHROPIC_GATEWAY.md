# Anthropic gateway configuration

V4 accepts an explicit host setting, `ANTHROPIC_BASE_URL`, for its Anthropic API provider. Set it on the API process before startup to select a Messages-compatible gateway. The default remains `https://api.anthropic.com`; an unset or blank value keeps that default.

The value is a base URL. V4 appends `v1/messages`, including after an existing path prefix. For example, `https://gateway.example/anthropic/` becomes `https://gateway.example/anthropic/v1/messages`. Existing URL validation requires HTTPS or HTTP loopback and rejects inline credentials, query strings and fragments. Redirects remain disabled.

Accounts still configure their own Anthropic API key through V4 Settings. The selected gateway receives that account key using the existing Anthropic authentication headers. An ambient `ANTHROPIC_API_KEY` does not replace the account vault credential. This process setting applies to the provider across accounts served by that API process. There is no per-message endpoint or endpoint editor in Settings.

Provider model selection and known/unknown image capabilities remain unchanged. Constructor and authenticated route tests cover configuration and credential isolation; they do not establish actual App image delivery. The selected-model App-to-loopback Messages check is a separate verification gate.
