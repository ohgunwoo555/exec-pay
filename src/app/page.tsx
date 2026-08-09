import PayExplorer from "@/components/PayExplorer";
import { loadPayData } from "@/lib/pay.server";

export default function Home() {
  const data = loadPayData();
  return <PayExplorer data={data} />;
}
