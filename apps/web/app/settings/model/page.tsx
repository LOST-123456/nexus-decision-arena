import type { Metadata } from "next";
import { ModelConfigPanel } from "../../../features/settings/model-config-panel";
import "../settings.css";

export const metadata: Metadata = {
  title: "模型设置 · Nexus Decision Arena",
  description: "配置你自己的模型接口与密钥。没有配置时，评审与主张提炼不可用。"
};

export default function ModelSettingsPage() {
  return (
    <main id="main" tabIndex={-1}>
      <ModelConfigPanel />
    </main>
  );
}
