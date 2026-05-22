import { useState, useMemo } from "react";
import { getAssetLogo } from "@/lib/assetLogos";
import { cn } from "@/lib/utils";

interface AssetIconProps {
  asset?: string;
  size?: number;
  className?: string;
}

/**
 * Unified asset icon. Tries Coincap CDN, falls back to TrustWallet assets
 * GitHub raw, and finally renders a deterministic initials circle. When no
 * asset has been selected yet, it renders a neutral blank marker instead of a
 * token-looking fallback string.
 */
export function AssetIcon({ asset = "", size = 36, className }: AssetIconProps) {
  const normalizedAsset = asset.trim().toUpperCase();
  const hasAsset = normalizedAsset.length > 0;
  const entry = hasAsset ? getAssetLogo(normalizedAsset) : undefined;
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const src = step === 0 ? entry?.primary : step === 1 ? entry?.fallback : undefined;

  const bg = useMemo(
    () => (hasAsset ? colorFor(normalizedAsset) : "oklch(0.62 0.22 262 / 0.22)"),
    [hasAsset, normalizedAsset]
  );

  const showText = hasAsset && !src;

  return (
    <div
      className={cn(
        "rounded-full overflow-hidden flex items-center justify-center shrink-0 shadow-sm",
        className
      )}
      style={{
        width: size,
        height: size,
        background: showText || !hasAsset ? bg : "#14203a",
      }}
      aria-label={hasAsset ? `${normalizedAsset} 资产图标` : "资产占位图标"}
    >
      {hasAsset && !showText && (
        <img
          src={src}
          alt={normalizedAsset}
          width={size}
          height={size}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setStep((s) => (s < 2 ? ((s + 1) as 1 | 2) : 2))}
        />
      )}
      {showText && (
        <span
          className="font-semibold text-white"
          style={{ fontSize: Math.max(10, size * 0.38) }}
        >
          {normalizedAsset.slice(0, 3)}
        </span>
      )}
    </div>
  );
}

function colorFor(asset: string): string {
  const palette = [
    "#3461eb",
    "#1fb26a",
    "#d64545",
    "#8e5cd9",
    "#e08a2a",
    "#2aa9c3",
    "#e14d8e",
    "#38997c",
  ];
  let h = 0;
  for (let i = 0; i < asset.length; i++) h = (h * 31 + asset.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
