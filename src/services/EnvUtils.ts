import { isMultiRootWorkspace } from "@/core/workspace/utils/workspace-detection"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { EmptyRequest } from "@/shared/proto/dietcode/common"
import { Logger } from "@/shared/services/Logger"

// Canonical header names for extra client/host context
export const DietCodeHeaders = {
	PLATFORM: "X-PLATFORM",
	PLATFORM_VERSION: "X-PLATFORM-VERSION",
	CLIENT_VERSION: "X-CLIENT-VERSION",
	CLIENT_TYPE: "X-CLIENT-TYPE",
	CORE_VERSION: "X-CORE-VERSION",
	IS_MULTIROOT: "X-IS-MULTIROOT",
} as const
export type DietCodeHeaderName = (typeof DietCodeHeaders)[keyof typeof DietCodeHeaders]

export function buildExternalBasicHeaders(): Record<string, string> {
	return {
		"User-Agent": `DietCode/${ExtensionRegistryInfo.version}`,
	}
}

export async function buildBasicDietCodeHeaders(): Promise<Record<string, string>> {
	const headers: Record<string, string> = buildExternalBasicHeaders()
	try {
		const host = await HostProvider.env.getHostVersion(EmptyRequest.create({}))
		headers[DietCodeHeaders.PLATFORM] = host.platform || "unknown"
		headers[DietCodeHeaders.PLATFORM_VERSION] = host.version || "unknown"
		headers[DietCodeHeaders.CLIENT_TYPE] = host.dietcodeType || "unknown"
		headers[DietCodeHeaders.CLIENT_VERSION] = host.dietcodeVersion || "unknown"
	} catch (error) {
		Logger.log("Failed to get IDE/platform info via HostBridge EnvService.getHostVersion", error)
		headers[DietCodeHeaders.PLATFORM] = "unknown"
		headers[DietCodeHeaders.PLATFORM_VERSION] = "unknown"
		headers[DietCodeHeaders.CLIENT_TYPE] = "unknown"
		headers[DietCodeHeaders.CLIENT_VERSION] = "unknown"
	}
	headers[DietCodeHeaders.CORE_VERSION] = ExtensionRegistryInfo.version

	return headers
}

export async function buildDietCodeExtraHeaders(): Promise<Record<string, string>> {
	const headers = await buildBasicDietCodeHeaders()

	try {
		const isMultiRoot = await isMultiRootWorkspace()
		headers[DietCodeHeaders.IS_MULTIROOT] = isMultiRoot ? "true" : "false"
	} catch (error) {
		Logger.log("Failed to detect multi-root workspace", error)
		headers[DietCodeHeaders.IS_MULTIROOT] = "false"
	}

	return headers
}

/** OpenRouter app attribution headers for rankings and analytics. */
export function buildOpenRouterAttributionHeaders(): Record<string, string> {
	return {
		"HTTP-Referer": "https://mariecoder.com",
		"X-OpenRouter-Title": "LUMI",
		"X-OpenRouter-Categories": "ide-extension",
	}
}
