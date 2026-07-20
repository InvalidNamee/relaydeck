import type { Metadata } from "next";
import { RemoteBrowser } from "./remote-browser";

export const metadata: Metadata = {
  title: "Relaydeck · 共享浏览器控制台",
  description: "一个 Chrome、多个独立页面控制端。",
};

export default function Home() {
  return <RemoteBrowser />;
}
