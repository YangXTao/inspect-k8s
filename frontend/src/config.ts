const resolveApiBaseUrl = () => {
  const rawValue = import.meta.env.VITE_API_BASE_URL;
  if (!rawValue || !rawValue.trim()) {
    return "/api";
  }
  const trimmed = rawValue.trim();
  if (trimmed.toLowerCase() === "auto") {
    if (typeof window === "undefined") {
      return "/api";
    }
    return `${window.location.origin}/api`;
  }
  if (typeof window === "undefined" || trimmed.startsWith("/")) {
    return trimmed;
  }
  try {
    const target = new URL(trimmed);
    const current = window.location;
    if (target.hostname === current.hostname) {
      const currentPort =
        current.port || (current.protocol === "https:" ? "443" : "80");
      const targetPort =
        target.port || (target.protocol === "https:" ? "443" : "80");
      if (
        target.protocol !== current.protocol ||
        targetPort !== currentPort
      ) {
        return `${current.protocol}//${current.host}${target.pathname}${target.search}${target.hash}`;
      }
    }
  } catch {
    return trimmed;
  }
  return trimmed;
};

export const appConfig = {
  apiBaseUrl: resolveApiBaseUrl(),
  branding: {
    logoUrl: "",
    logoText: "Kubernetes 巡检中心",
  },
};

