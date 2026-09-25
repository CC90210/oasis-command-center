"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2 } from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";

export function ProvisioningProgress({ run }: { run: any }) {
  const router = useRouter();
  const [steps, setSteps] = useState<{ title: string; time: string }[]>([]);

  useEffect(() => {
    try {
      if (run.steps_json) {
        setSteps(JSON.parse(run.steps_json));
      }
    } catch {
      //
    }

    // Auto refresh every 3 seconds to check for updates
    const interval = setInterval(() => {
      router.refresh();
    }, 3000);
    return () => clearInterval(interval);
  }, [run.steps_json, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-6 font-sans antialiased text-fg">
      <div className="w-full max-w-md bg-bg-elev border border-bg-border rounded-xl p-8 shadow-2xl relative overflow-hidden">
        {/* Glow */}
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-accent/20 via-accent to-accent/20" />
        
        <div className="flex flex-col items-center text-center space-y-6">
          <OasisLogo className="w-12 h-12" />
          
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">Setting up your workspace</h1>
            <p className="text-sm text-fg-muted">
              We're provisioning your dedicated infrastructure and initializing your agents.
              This usually takes less than a minute.
            </p>
          </div>

          <div className="w-full space-y-4 text-left mt-8">
            <div className="flex items-center gap-3 text-sm font-medium text-fg">
              <CheckCircle2 className="w-4 h-4 text-accent" />
              <span>Payment verified</span>
            </div>
            
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-3 text-sm font-medium text-fg">
                <CheckCircle2 className="w-4 h-4 text-accent" />
                <span>{step.title}</span>
              </div>
            ))}

            <div className="flex items-center gap-3 text-sm font-medium text-fg-muted animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              <span>Configuring environment...</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
