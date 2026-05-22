import { useState } from "react";
import { ArrowDownToLine, Loader2, CheckCircle2, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { sendToRabbit, isInRabbitApp } from "@/_core/hooks/useRabbitBridge";
import { AssetIcon } from "@/components/AssetIcon";

// ERC20 token contract addresses on common EVM chains
const ERC20_CONTRACTS: Record<string, Record<string, string>> = {
  erc20: {
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  bep20: {
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    BNB: "native",
  },
  polygon: {
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    MATIC: "native",
  },
  arbitrum: {
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    ETH: "native",
  },
  optimism: {
    USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    OP: "0x4200000000000000000000000000000000000042",
    ETH: "native",
  },
};

// Chain ID mapping for EVM chains
const CHAIN_IDS: Record<string, number> = {
  erc20: 1,
  bep20: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
};

// ERC20 transfer function signature
const ERC20_TRANSFER_ABI = "0xa9059cbb";

function encodeERC20Transfer(to: string, amount: string, decimals: number): string {
  // Encode: transfer(address to, uint256 amount)
  const toAddress = to.toLowerCase().replace("0x", "").padStart(64, "0");
  const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));
  const amountHex = amountBigInt.toString(16).padStart(64, "0");
  return `${ERC20_TRANSFER_ABI}${toAddress}${amountHex}`;
}

function toHexWei(amount: string, decimals: number): string {
  const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));
  return "0x" + amountBigInt.toString(16);
}

interface WalletTransferProps {
  asset: string;
  chain: string;
  depositAddress: string | undefined;
}

export function WalletTransfer({ asset, chain, depositAddress }: WalletTransferProps) {
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState("");

  // Only show for EVM chains when in Rabbit App
  const isEVM = chain in CHAIN_IDS;
  if (!isInRabbitApp() || !isEVM) return null;

  const chainId = CHAIN_IDS[chain];
  const contractAddress = ERC20_CONTRACTS[chain]?.[asset];
  const isNativeToken = contractAddress === "native" || asset === "ETH";
  const decimals = ["USDT", "USDC"].includes(asset) && chain !== "bep20" ? 6 : 18;

  const handleTransfer = async () => {
    if (!depositAddress) {
      toast.error("充值地址未生成，请稍后再试");
      return;
    }
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount <= 0) {
      toast.error("请输入有效的充值金额");
      return;
    }
    if (!isNativeToken && !contractAddress) {
      toast.error(`当前网络不支持 ${asset} 的一键划转，请使用手动转账`);
      return;
    }

    setStatus("sending");
    try {
      let txParams: any;

      if (isNativeToken) {
        // Native token transfer (ETH, BNB, MATIC)
        txParams = {
          to: depositAddress,
          value: toHexWei(amount, 18),
          chainId,
        };
      } else {
        // ERC20 token transfer
        txParams = {
          to: contractAddress,
          value: "0x0",
          data: encodeERC20Transfer(depositAddress, amount, decimals),
          chainId,
        };
      }

      const result = await sendToRabbit<{ txHash: string }>("sendTransaction", txParams);

      if (result.txHash) {
        setTxHash(result.txHash);
        setStatus("success");
        toast.success("转账已发起，等待链上确认后自动入账");
      } else {
        setStatus("error");
        toast.error("转账失败，请重试");
      }
    } catch (err: any) {
      setStatus("error");
      if (err?.message?.includes("取消") || err?.message?.includes("cancel") || err?.message?.includes("reject")) {
        toast.info("您已取消转账");
      } else {
        toast.error(err?.message ?? "转账失败");
      }
    }
  };

  const reset = () => {
    setStatus("idle");
    setAmount("");
    setTxHash("");
  };

  if (status === "success") {
    return (
      <div className="rounded-[22px] p-4 mb-4 bg-up/5 border border-up/20 shadow-sm">
        <div className="flex flex-col items-center gap-3 py-2">
          <CheckCircle2 className="w-10 h-10 text-up" />
          <div className="text-sm font-semibold text-up">转账已发起</div>
          <p className="text-xs text-muted-foreground text-center">
            交易已提交到链上，确认后将自动入账到您的交易所余额。
          </p>
          {txHash && (
            <div className="text-[11px] font-mono text-muted-foreground break-all px-4">
              TxHash: {txHash.slice(0, 10)}...{txHash.slice(-8)}
            </div>
          )}
          <button
            onClick={reset}
            className="mt-2 h-9 px-5 rounded-xl text-xs font-semibold text-primary border border-primary/30 bg-primary/10"
          >
            继续充值
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-[22px] p-4 mb-4 bg-gradient-to-br from-primary/5 to-primary/10 border border-primary/20 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Wallet className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold">快捷充值</h2>
        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
          从钱包划转
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        直接从 Rabbit 钱包划转 {asset} 到交易所，无需手动复制地址。
      </p>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-2xl ui-field">
          <AssetIcon asset={asset} size={20} />
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={`输入 ${asset} 数量`}
            className="flex-1 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/60 outline-none border-none"
          />
        </div>
      </div>
      <button
        onClick={handleTransfer}
        disabled={status === "sending" || !amount || !depositAddress}
        className={cn(
          "w-full h-12 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold transition-all",
          status === "sending"
            ? "bg-primary/50 text-primary-foreground cursor-wait"
            : "bg-primary text-primary-foreground active:bg-primary/90 disabled:opacity-50"
        )}
      >
        {status === "sending" ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> 确认中…</>
        ) : (
          <><ArrowDownToLine className="w-4 h-4" /> 从钱包划转到交易所</>
        )}
      </button>
      {!contractAddress && !isNativeToken && (
        <p className="mt-2 text-[11px] text-amber-500 text-center">
          当前网络暂不支持 {asset} 快捷充值，请使用上方地址手动转账。
        </p>
      )}
    </section>
  );
}
