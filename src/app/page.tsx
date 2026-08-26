import AuthGate from "@/components/AuthGate";
import StudyApp from "@/components/StudyApp";

export default function Home() {
  return <AuthGate><StudyApp /></AuthGate>;
}
