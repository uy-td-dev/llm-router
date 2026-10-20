"use client";

import ProviderCatalog from "./ProviderCatalog";
import { Server } from "lucide-react";
import { PageHeader } from "@/components/ui";

export default function ProvidersClient({ role }: { role: string }) {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="Providers"
        desc="Bấm vào một provider để kết nối tài khoản, quản lý nhiều account (priority / weight / bật-tắt), xem model và đặt prefix."
      />
      <ProviderCatalog isAdmin={role === "admin"} />
    </div>
  );
}
