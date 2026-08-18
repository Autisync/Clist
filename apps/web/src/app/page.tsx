import { redirect } from "next/navigation";

// Trivial placeholder — routing/auth split (office vs. field) is decided
// by role once real auth-aware landing pages exist (later stage). For now
// this just proves the scaffold compiles and picks a default.
export default function Home() {
  redirect("/office");
}
