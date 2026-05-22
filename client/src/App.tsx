import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Market from "./pages/Market";
import TradePair from "./pages/TradePair";
import QuotePair from "./pages/QuotePair";
import Deposit from "./pages/Deposit";
import Withdraw from "./pages/Withdraw";
import Transfer from "./pages/Transfer";
import Orders from "./pages/Orders";
import Discover from "./pages/Discover";
import Me from "./pages/Me";
import Admin from "./pages/Admin";
import ApiDocs from "./pages/ApiDocs";
import ApiKeys from "./pages/ApiKeys";
import AdminPanel from "./pages/AdminPanel";
import TradeHistory from "./pages/TradeHistory";
import { WalletShell } from "./components/WalletShell";
import { InvitationCodeDialog } from "./components/InvitationCodeDialog";
import { useReferralDialog } from "./_core/hooks/useReferralDialog";

function ReferralDialogWrapper() {
  const { showDialog, closeDialog } = useReferralDialog();
  return <InvitationCodeDialog open={showDialog} onClose={closeDialog} />;
}

function Router() {
  return (
    <Switch>
      {/* Browser-first full-page admin panel - outside WalletShell */}
      <Route path="/admin/:section?" component={AdminPanel} />
      <Route path="/admin-panel/:section?" component={AdminPanel} />
      <Route>
        <WalletShell>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/market" component={Market} />
            <Route path="/quote/:symbol" component={QuotePair} />
            <Route path="/trade/:symbol" component={TradePair} />
            <Route path="/deposit" component={Deposit} />
            <Route path="/withdraw" component={Withdraw} />
            <Route path="/transfer" component={Transfer} />
            <Route path="/orders" component={Orders} />
            <Route path="/discover" component={Discover} />
            <Route path="/me" component={Me} />
            <Route path="/admin-mobile" component={Admin} />
            <Route path="/trades" component={TradeHistory} />
            <Route path="/me/api-keys" component={ApiKeys} />
            <Route path="/docs/api" component={ApiDocs} />
            <Route path="/404" component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </WalletShell>
      </Route>
    </Switch>
  );
}
function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark" switchable>
        <TooltipProvider>
          <Toaster />
          <ReferralDialogWrapper />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
export default App;
