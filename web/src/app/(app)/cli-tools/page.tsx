import CliToolsClient from "./CliToolsClient";

export default function CliToolsPage() {
  const base = (process.env.ROUTER_PUBLIC_URL || process.env.ROUTER_URL || "http://localhost:8080").replace(/\/$/, "");
  return <CliToolsClient baseUrl={base} />;
}
