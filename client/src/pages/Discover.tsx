import { Link } from "wouter";
import { ChevronLeft } from "lucide-react";

export default function Discover() {
  return (
    <div className="w-full px-4 pt-4 pb-8">
      <header className="flex items-center gap-2">
        <Link href="/">
          <button className="p-1 -ml-1 text-muted-foreground">
            <ChevronLeft className="w-6 h-6" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold">发现</h1>
      </header>
    </div>
  );
}
