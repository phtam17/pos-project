import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type SVGProps
} from "react";
import QRCode from "qrcode";

import {
  ApiError,
  api,
  type AmountMinor,
  type CartDto,
  type CartLineDto,
  type OrderDto,
  type PaymentAttemptDto,
  type ProductDto,
  type ReceiptDto,
  type Tender,
  type VietnamQrWallet
} from "./api";

type PaymentPhase =
  | "idle"
  | "checking-out"
  | "awaiting-card"
  | "awaiting-qr"
  | "processing"
  | "captured"
  | "declined"
  | "unknown";

interface PaymentState {
  phase: PaymentPhase;
  message: string;
}

interface PendingPayment {
  order: OrderDto;
  tender: Tender;
  idempotencyKey: string;
}

interface PendingCheckout {
  readonly cartId: string;
  readonly tender: Tender;
  readonly idempotencyKey: string;
}

interface RecentSale {
  order: OrderDto;
  payment: PaymentAttemptDto;
  receipt?: ReceiptDto;
}

const TERMINAL_ID = (import.meta.env.VITE_TERMINAL_ID as string | undefined) ?? "terminal-01";
const SUCCESS_STATUSES = new Set(["CAPTURED", "PAID", "COMPLETED", "SUCCEEDED", "APPROVED"]);
const DECLINED_STATUSES = new Set(["DECLINED", "FAILED", "CANCELED", "CANCELLED"]);

const EMPTY_PAYMENT: PaymentState = {
  phase: "idle",
  message: "Choose a payment method when the cart is ready."
};

function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      {name === "search" && <><circle cx="11" cy="11" r="7" {...common} /><path d="m20 20-4-4" {...common} /></>}
      {name === "barcode" && <><path d="M3 5v14M6 5v14M10 5v14M13 5v14M18 5v14M21 5v14" {...common} /></>}
      {name === "plus" && <><path d="M12 5v14M5 12h14" {...common} /></>}
      {name === "trash" && <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" {...common} /></>}
      {name === "card" && <><rect x="3" y="5" width="18" height="14" rx="2.5" {...common} /><path d="M3 10h18M7 15h4" {...common} /></>}
      {name === "cash" && <><rect x="3" y="6" width="18" height="13" rx="2" {...common} /><path d="M7 9h10M7 16h10" {...common} /><circle cx="12" cy="12.5" r="2.5" {...common} /></>}
      {name === "qr" && <><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" {...common} /><path d="M14 14h2v2h-2zM18 14h2v6h-2M14 18h2v2h-2" {...common} /></>}
      {name === "receipt" && <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" {...common} /><path d="M9 8h6M9 12h6M9 16h3" {...common} /></>}
      {name === "orders" && <><rect x="4" y="4" width="16" height="16" rx="3" {...common} /><path d="M8 9h8M8 13h8M8 17h5" {...common} /></>}
      {name === "chevron" && <path d="m9 6 6 6-6 6" {...common} />}
      {name === "close" && <><path d="m6 6 12 12M18 6 6 18" {...common} /></>}
      {name === "print" && <><path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" {...common} /><path d="M7 14h10v7H7z" {...common} /></>}
      {name === "retry" && <><path d="M20 7v5h-5" {...common} /><path d="M18.5 16a8 8 0 1 1 1-8.5L20 12" {...common} /></>}
      {name === "check" && <path d="m5 12 4 4L19 6" {...common} />}
      {name === "alert" && <><path d="M12 8v5M12 17h.01" {...common} /><path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.8 3h15.2a2 2 0 0 0 1.8-3L13.7 4.3a2 2 0 0 0-3.4 0Z" {...common} /></>}
      {name === "lock" && <><rect x="5" y="10" width="14" height="11" rx="2.5" {...common} /><path d="M8 10V7a4 4 0 0 1 8 0v3" {...common} /></>}
      {name === "signal" && <><path d="M5 16.5a10 10 0 0 1 14 0M8 13a6 6 0 0 1 8 0M11 9.5a2 2 0 0 1 2 0" {...common} /><circle cx="12" cy="19" r=".75" fill="currentColor" /></>}
    </svg>
  );
}

function formatMoney(value: AmountMinor, currency = "USD"): string {
  const minor = Number(value);
  const safeMinor = Number.isFinite(minor) ? minor : 0;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2
    }).format(safeMinor / 100);
  } catch {
    return `${currency} ${(safeMinor / 100).toFixed(2)}`;
  }
}

function formatDate(value?: string): string {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatReceiptDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function makeIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `register-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function productInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function fallbackReceipt(order: OrderDto, payment: PaymentAttemptDto): ReceiptDto {
  return {
    orderId: order.id,
    orderNumber: order.number,
    currency: order.currency,
    createdAt: payment.createdAt ?? order.createdAt ?? new Date().toISOString(),
    lines: order.lines,
    subtotalMinor: order.subtotalMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    tender: payment.tender,
    paymentStatus: payment.status,
    ...(payment.cardBrand ? { cardBrand: payment.cardBrand } : {}),
    ...(payment.last4 ? { last4: payment.last4 } : {}),
    ...(payment.wallet ? { wallet: payment.wallet } : {})
  };
}

function ReceiptDialog({ receipt, onClose }: { receipt: ReceiptDto; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const paymentLabel = receipt.tender === "card"
    ? `${receipt.cardBrand ?? "Card"}${receipt.last4 ? ` •••• ${receipt.last4}` : ""}`
    : receipt.tender === "vietnam_qr"
      ? `Vietnam QR · ${walletLabel(receipt.wallet)}`
      : receipt.tender === "cash"
      ? "Cash · Exact amount"
      : "Payment received";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div className="receipt-actions no-print">
          <button className="icon-button" type="button" onClick={() => window.print()} aria-label="Print receipt">
            <Icon name="print" />
          </button>
          <button ref={closeButton} className="icon-button" type="button" onClick={onClose} aria-label="Close receipt">
            <Icon name="close" />
          </button>
        </div>

        <div className="receipt-paper">
          <div className="receipt-brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <p className="receipt-eyebrow">Open POS</p>
          <h2 id="receipt-title">Payment received</h2>
          <p className="receipt-subtitle">Order #{receipt.orderNumber} · {formatReceiptDate(receipt.createdAt)}</p>

          <div className="receipt-rule" />
          <div className="receipt-lines">
            {receipt.lines.map((line) => (
              <div className="receipt-line" key={line.id}>
                <div><span>{line.quantity} × {line.name}</span><small>{formatMoney(line.unitPriceMinor, receipt.currency)} each</small></div>
                <strong>{formatMoney(line.lineTotalMinor, receipt.currency)}</strong>
              </div>
            ))}
          </div>
          <div className="receipt-rule" />

          <dl className="receipt-totals">
            <div><dt>Subtotal</dt><dd>{formatMoney(receipt.subtotalMinor, receipt.currency)}</dd></div>
            <div><dt>Tax</dt><dd>{formatMoney(receipt.taxMinor, receipt.currency)}</dd></div>
            <div className="receipt-grand-total"><dt>Total</dt><dd>{formatMoney(receipt.totalMinor, receipt.currency)}</dd></div>
          </dl>

          <div className="receipt-payment">
            <span><Icon name="check" /> Paid</span>
            <strong>{paymentLabel}</strong>
          </div>
          <p className="receipt-thanks">Thank you for your purchase.</p>
        </div>
      </section>
    </div>
  );
}

function walletLabel(wallet?: VietnamQrWallet): string {
  if (wallet === "VCB") return "VCB Digibank";
  if (wallet === "MOMO") return "MoMo";
  if (wallet === "ZALOPAY") return "ZaloPay";
  if (wallet === "SHOPEEPAY_VN") return "ShopeePay VN";
  return "Vietnamese wallet";
}

function SandboxQrPanel({
  payment,
  amountMinor,
  currency,
  busy,
  onComplete
}: {
  payment: PaymentAttemptDto;
  amountMinor: AmountMinor;
  currency: string;
  busy: boolean;
  onComplete: (wallet: VietnamQrWallet, outcome: "APPROVED" | "DECLINED" | "EXPIRED") => void;
}) {
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const presentation = payment.presentation;

  useEffect(() => {
    if (!presentation) return;
    let active = true;
    void QRCode.toDataURL(presentation.payload, {
      width: 228,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#13251d", light: "#ffffff" }
    }).then((value) => {
      if (active) setQrImage(value);
    });
    return () => { active = false; };
  }, [presentation]);

  useEffect(() => {
    if (!presentation) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((new Date(presentation.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [presentation]);

  if (!presentation) return null;
  const estimatedVnd = Math.round(Number(amountMinor) * 255);

  return (
    <section className="sandbox-qr" aria-labelledby="sandbox-qr-title">
      <div className="sandbox-qr-heading">
        <div><span className="sandbox-badge">Sandbox demo</span><h3 id="sandbox-qr-title">Scan with a Vietnam payment app</h3></div>
        <strong>{formatMoney(amountMinor, currency)}</strong>
      </div>
      <div className="sandbox-qr-body">
        <div className="qr-frame">
          {qrImage ? <img src={qrImage} alt="Sandbox Vietnam QR payment code" /> : <span className="spinner" />}
          <small>Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</small>
        </div>
        <div className="qr-instructions">
          <p>In production, the customer scans this order-specific code and approves approximately <strong>{new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(estimatedVnd)}</strong>.</p>
          <span>Choose a wallet below to simulate its signed payment confirmation:</span>
          <div className="wallet-grid">
            {presentation.supportedWallets.map((wallet) => (
              <button key={wallet} type="button" disabled={busy} onClick={() => onComplete(wallet, "APPROVED")}>
                <b>{walletLabel(wallet)}</b><small>Simulate approval</small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="sandbox-qr-controls">
        <button type="button" disabled={busy} onClick={() => onComplete("VCB", "DECLINED")}>Simulate decline</button>
        <button type="button" disabled={busy} onClick={() => onComplete("VCB", "EXPIRED")}>Expire / cancel QR</button>
      </div>
      <p className="sandbox-warning"><Icon name="alert" /> This QR contains a test URL and cannot move money or be paid by a real banking app.</p>
    </section>
  );
}

function CartLine({
  line,
  currency,
  disabled,
  onAdd,
  onRemove
}: {
  line: CartLineDto;
  currency: string;
  disabled: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="cart-line">
      <div className="cart-line-main">
        <div>
          <strong>{line.name}</strong>
          <span>{formatMoney(line.unitPriceMinor, currency)} each</span>
        </div>
        <strong className="line-total">{formatMoney(line.lineTotalMinor, currency)}</strong>
      </div>
      <div className="line-controls">
        <span className="quantity-label">Qty {line.quantity}</span>
        <button type="button" onClick={onAdd} disabled={disabled} aria-label={`Add another ${line.name}`}>
          <Icon name="plus" />
        </button>
        <button className="remove-line" type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${line.name} from cart`}>
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

export function App() {
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [cart, setCart] = useState<CartDto | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [category, setCategory] = useState("All");
  const [loading, setLoading] = useState(true);
  const [cartBusy, setCartBusy] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentState>(EMPTY_PAYMENT);
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null);
  const [qrAttempt, setQrAttempt] = useState<PaymentAttemptDto | null>(null);
  const [pendingCheckout, setPendingCheckout] = useState<PendingCheckout | null>(null);
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [recentSales, setRecentSales] = useState<RecentSale[]>([]);
  const [now, setNow] = useState(() => new Date());
  const initialized = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const initialize = async () => {
    setLoading(true);
    setPageError(null);
    try {
      const [nextProducts, nextCart] = await Promise.all([api.listProducts(), api.createCart()]);
      setProducts(nextProducts);
      setCart(nextCart);
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void initialize();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const categories = useMemo(() => {
    const values = Array.from(new Set(products.map((product) => product.category))).sort();
    return ["All", ...values];
  }, [products]);

  const filteredProducts = useMemo(() => {
    const query = deferredSearch.trim().toLocaleLowerCase();
    return products.filter((product) => {
      const matchesCategory = category === "All" || product.category === category;
      if (!matchesCategory) return false;
      if (!query) return true;
      return [product.name, product.sku, product.barcode ?? "", product.category]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [category, deferredSearch, products]);

  const saleLocked = pendingPayment !== null || pendingCheckout !== null || paymentBusy;
  const canTender = Boolean(cart && cart.lines.length > 0 && Number(cart.totalMinor) > 0 && !cartBusy && !paymentBusy && !saleLocked);

  const addProduct = async (product: ProductDto) => {
    if (!cart || cartBusy || saleLocked) return;
    setCartBusy(true);
    setPageError(null);
    try {
      setCart(await api.addCartLine(cart.id, product.id, 1));
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setCartBusy(false);
      searchInput.current?.focus();
    }
  };

  const removeLine = async (line: CartLineDto) => {
    if (!cart || cartBusy || saleLocked) return;
    setCartBusy(true);
    setPageError(null);
    try {
      setCart(await api.removeCartLine(cart.id, line.id));
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setCartBusy(false);
    }
  };

  const completePayment = async (pending: PendingPayment, payment: PaymentAttemptDto) => {
    const fallback = fallbackReceipt(pending.order, payment);
    let finalReceipt = fallback;
    try {
      finalReceipt = await api.getReceipt(pending.order.id);
    } catch {
      setNotice("Payment succeeded. The live receipt was unavailable, so a local copy is shown.");
    }

    setReceipt(finalReceipt);
    setRecentSales((sales) => [{ order: pending.order, payment, receipt: finalReceipt }, ...sales].slice(0, 4));
    setPaymentState({ phase: "captured", message: "Payment approved. The sale is complete." });
  };

  const submitPayment = async (pending: PendingPayment) => {
    setPaymentBusy(true);
    setPageError(null);
    setPendingPayment(pending);
    setPaymentState({
      phase: pending.tender === "card" ? "awaiting-card" : pending.tender === "vietnam_qr" ? "awaiting-qr" : "processing",
      message: pending.tender === "card"
        ? "Ask the customer to tap or insert their card."
        : pending.tender === "vietnam_qr"
          ? "Creating a one-time Vietnam QR code…"
          : "Recording exact cash tender…"
    });

    try {
      const payment = await api.createPaymentAttempt(
        pending.order.id,
        pending.tender,
        pending.idempotencyKey,
        pending.tender === "card" ? TERMINAL_ID : undefined
      );

      if (payment.presentation && payment.tender === "vietnam_qr") {
        setQrAttempt(payment);
        setPaymentState({
          phase: "awaiting-qr",
          message: "Waiting for the selected Vietnamese app to confirm payment."
        });
      } else if (SUCCESS_STATUSES.has(payment.status)) {
        setQrAttempt(null);
        await completePayment(pending, payment);
      } else if (DECLINED_STATUSES.has(payment.status)) {
        setPaymentState({
          phase: "declined",
          message: payment.failureMessage ?? "Payment was declined. No charge was completed."
        });
      } else {
        setPaymentState({
          phase: payment.status === "AWAITING_CARD" ? "awaiting-card" : "unknown",
          message: payment.status === "AWAITING_CARD"
            ? "The reader is still waiting for a card."
            : "The final result is not confirmed. Check safely before trying another payment."
        });
      }
    } catch (error) {
      const confirmedRejection = error instanceof ApiError && error.status > 0 && error.status < 500;
      setPaymentState(confirmedRejection
        ? {
            phase: "declined",
            message: `${errorMessage(error)} No new charge was started.`
          }
        : {
            phase: "unknown",
            message: `${errorMessage(error)} The result may be unknown; do not start a second charge.`
          });
    } finally {
      setPaymentBusy(false);
    }
  };

  const completeSandboxQr = async (
    wallet: VietnamQrWallet,
    outcome: "APPROVED" | "DECLINED" | "EXPIRED"
  ) => {
    if (!qrAttempt || !pendingPayment || paymentBusy) return;
    setPaymentBusy(true);
    setPageError(null);
    try {
      const payment = await api.completeSandboxVietnamQr(qrAttempt.id, wallet, outcome);
      setQrAttempt(null);
      if (SUCCESS_STATUSES.has(payment.status)) {
        await completePayment(pendingPayment, payment);
      } else {
        setPaymentState({
          phase: "declined",
          message: payment.failureMessage ?? (outcome === "EXPIRED"
            ? "The QR code expired without moving money."
            : "The sandbox customer declined the payment.")
        });
      }
    } catch (error) {
      setPaymentState({
        phase: "unknown",
        message: `${errorMessage(error)} Check the same attempt before trying another payment.`
      });
    } finally {
      setPaymentBusy(false);
    }
  };

  const submitCheckout = async (pending: PendingCheckout) => {
    if (!cart || cart.id !== pending.cartId) return;
    setPaymentBusy(true);
    setPendingCheckout(pending);
    setPageError(null);
    setPaymentState({ phase: "checking-out", message: "Locking the order total…" });

    try {
      const order = await api.checkoutCart(cart.id, pending.idempotencyKey);
      setPendingCheckout(null);
      const payment: PendingPayment = {
        order,
        tender: pending.tender,
        idempotencyKey: makeIdempotencyKey()
      };
      await submitPayment(payment);
    } catch (error) {
      const confirmedRejection = error instanceof ApiError && error.status > 0 && error.status < 500;
      if (confirmedRejection) {
        setPendingCheckout(null);
        setPaymentState(EMPTY_PAYMENT);
        setPageError(errorMessage(error));
      } else {
        setPaymentState({
          phase: "unknown",
          message: `${errorMessage(error)} The checkout result is unknown; recover this same checkout before editing the cart.`
        });
      }
      setPaymentBusy(false);
    }
  };

  const beginPayment = async (tender: Tender) => {
    if (!cart || !canTender) return;
    await submitCheckout({
      cartId: cart.id,
      tender,
      idempotencyKey: `checkout-${cart.id}`
    });
  };

  const retryCheckout = () => {
    if (!pendingCheckout || paymentBusy) return;
    void submitCheckout(pendingCheckout);
  };

  const retrySameAttempt = () => {
    if (!pendingPayment || paymentBusy) return;
    void submitPayment(pendingPayment);
  };

  const retryDeclined = (tender: Tender) => {
    if (!pendingPayment || paymentBusy) return;
    void submitPayment({
      order: pendingPayment.order,
      tender,
      idempotencyKey: makeIdempotencyKey()
    });
  };

  const newSale = async () => {
    if (paymentBusy) return;
    setCartBusy(true);
    setPageError(null);
    try {
      const nextCart = await api.createCart();
      setCart(nextCart);
      setPendingPayment(null);
      setQrAttempt(null);
      setPendingCheckout(null);
      setPaymentState(EMPTY_PAYMENT);
      setReceipt(null);
      setSearch("");
      setCategory("All");
      window.setTimeout(() => searchInput.current?.focus(), 0);
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setCartBusy(false);
    }
  };

  const showRecentReceipt = async (sale: RecentSale) => {
    if (sale.receipt) {
      setReceipt(sale.receipt);
      return;
    }
    try {
      setReceipt(await api.getReceipt(sale.order.id));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && filteredProducts.length === 1 && filteredProducts[0]) {
      event.preventDefault();
      void addProduct(filteredProducts[0]);
    }
  };

  const jumpToActivity = () => document.getElementById("recent-activity")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div><strong>Open POS</strong><span>Downtown · Register 01</span></div>
        </div>

        <nav className="main-nav" aria-label="Register sections">
          <button className="nav-item active" type="button"><Icon name="card" />Checkout</button>
          <button className="nav-item" type="button" onClick={jumpToActivity}><Icon name="orders" />Orders</button>
        </nav>

        <div className="register-health">
          <span className="header-time">{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)}</span>
          <span className="health-pill"><i /> Register open</span>
          <span className="reader-pill"><Icon name="signal" /> Reader ready</span>
        </div>
      </header>

      <main className="register-layout">
        <section className="catalog-panel" aria-labelledby="catalog-title">
          <div className="catalog-heading">
            <div>
              <p className="eyebrow">Current sale</p>
              <h1 id="catalog-title">What are we ringing up?</h1>
            </div>
            <span className="date-label">{new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(now)}</span>
          </div>

          <div className="search-wrap">
            <Icon name="search" />
            <label className="sr-only" htmlFor="product-search">Search products, SKU, or barcode</label>
            <input
              ref={searchInput}
              id="product-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search products, SKU, or barcode"
              autoComplete="off"
              autoFocus
            />
            <span className="search-hint"><Icon name="barcode" /> Scan ready</span>
          </div>

          <div className="category-tabs" role="group" aria-label="Product categories">
            {categories.map((value) => (
              <button
                type="button"
                key={value}
                className={category === value ? "active" : ""}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                {value}
              </button>
            ))}
          </div>

          {pageError && (
            <div className="error-banner" role="alert">
              <Icon name="alert" />
              <span>{pageError}</span>
              {loading ? <button type="button" onClick={() => void initialize()}>Try again</button> : <button type="button" onClick={() => setPageError(null)}>Dismiss</button>}
            </div>
          )}

          <div className="product-region" aria-live="polite" aria-busy={loading || cartBusy}>
            {loading ? (
              <div className="product-grid" aria-label="Loading products">
                {Array.from({ length: 8 }, (_, index) => <div className="product-card skeleton" key={index}><span /><span /><span /></div>)}
              </div>
            ) : filteredProducts.length > 0 ? (
              <div className="product-grid">
                {filteredProducts.map((product, index) => (
                  <button
                    className="product-card"
                    type="button"
                    key={product.id}
                    onClick={() => void addProduct(product)}
                    disabled={!product.available || cartBusy || saleLocked}
                    aria-label={`Add ${product.name}, ${formatMoney(product.priceMinor, product.currency)}`}
                  >
                    <span className={`product-swatch tone-${index % 6}`}>{productInitials(product.name)}</span>
                    <span className="product-copy"><strong>{product.name}</strong><small>{product.sku} · {product.category}</small></span>
                    <span className="product-price">{formatMoney(product.priceMinor, product.currency)}</span>
                    <span className="add-product" aria-hidden="true"><Icon name="plus" /></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-catalog">
                <Icon name="search" />
                <h2>No products found</h2>
                <p>Try another name, SKU, barcode, or category.</p>
                <button type="button" onClick={() => { setSearch(""); setCategory("All"); }}>Clear filters</button>
              </div>
            )}
          </div>

          <section className="activity-panel" id="recent-activity" aria-labelledby="activity-title">
            <div className="activity-title-row">
              <div><p className="eyebrow">This register</p><h2 id="activity-title">Recent activity</h2></div>
              <span>{recentSales.length} completed</span>
            </div>
            {recentSales.length === 0 ? (
              <div className="activity-empty"><span className="activity-icon"><Icon name="receipt" /></span><div><strong>Completed sales appear here</strong><p>Receipts and the refund workflow will be available from this register session.</p></div></div>
            ) : (
              <ul className="sale-list">
                {recentSales.map((sale) => (
                  <li key={sale.order.id}>
                    <button className="sale-summary" type="button" onClick={() => void showRecentReceipt(sale)}>
                      <span className="activity-icon success"><Icon name="check" /></span>
                      <span><strong>Order #{sale.order.number}</strong><small>{formatDate(sale.payment.createdAt ?? sale.order.createdAt)} · {sale.payment.tender === "card" ? sale.payment.cardBrand ?? "Card" : sale.payment.tender === "vietnam_qr" ? walletLabel(sale.payment.wallet) : "Cash"}</small></span>
                      <b>{formatMoney(sale.order.totalMinor, sale.order.currency)}</b>
                      <Icon name="chevron" />
                    </button>
                    <button className="refund-placeholder" type="button" onClick={() => setNotice("Refunds are a placeholder in this skeleton; connect a manager-authorized refund endpoint before enabling them.")}>Refund</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>

        <aside className="cart-panel" aria-labelledby="cart-title" aria-busy={cartBusy || paymentBusy}>
          <div className="cart-header">
            <div><p className="eyebrow">Register 01</p><h2 id="cart-title">Current cart</h2></div>
            <span className="cart-count">{cart?.lines.reduce((sum, line) => sum + line.quantity, 0) ?? 0} items</span>
          </div>

          <div className="cart-body">
            {!cart || cart.lines.length === 0 ? (
              <div className="empty-cart">
                <span><Icon name="receipt" /></span>
                <h3>Your cart is empty</h3>
                <p>Select a product or scan a barcode to start a sale.</p>
              </div>
            ) : (
              <ul className="cart-lines">
                {cart.lines.map((line) => (
                  <CartLine
                    key={line.id}
                    line={line}
                    currency={cart.currency}
                    disabled={cartBusy || saleLocked}
                    onAdd={() => {
                      const product = products.find((candidate) => candidate.id === line.productId);
                      if (product) void addProduct(product);
                    }}
                    onRemove={() => void removeLine(line)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="checkout-area">
            <dl className="totals">
              <div><dt>Subtotal</dt><dd>{formatMoney(cart?.subtotalMinor ?? "0", cart?.currency)}</dd></div>
              <div><dt>Tax</dt><dd>{formatMoney(cart?.taxMinor ?? "0", cart?.currency)}</dd></div>
              <div className="grand-total"><dt>Total</dt><dd>{formatMoney(cart?.totalMinor ?? "0", cart?.currency)}</dd></div>
            </dl>

            {paymentState.phase !== "idle" && (
              <div className={`payment-status status-${paymentState.phase}`} role="status" aria-live="polite">
                <span className="status-icon">
                  {paymentState.phase === "captured" ? <Icon name="check" /> : paymentState.phase === "declined" || paymentState.phase === "unknown" ? <Icon name="alert" /> : <span className="spinner" />}
                </span>
                <div><strong>{paymentState.phase === "captured" ? "Sale complete" : paymentState.phase === "declined" ? "Payment declined" : paymentState.phase === "unknown" ? "Result needs attention" : paymentState.phase === "awaiting-qr" ? "Vietnam QR ready" : "Payment in progress"}</strong><p>{paymentState.message}</p></div>
              </div>
            )}

            {paymentState.phase === "awaiting-qr" && qrAttempt && pendingPayment && (
              <SandboxQrPanel
                payment={qrAttempt}
                amountMinor={pendingPayment.order.totalMinor}
                currency={pendingPayment.order.currency}
                busy={paymentBusy}
                onComplete={(wallet, outcome) => void completeSandboxQr(wallet, outcome)}
              />
            )}

            {paymentState.phase === "idle" && (
              <div className="tender-grid">
                <button className="pay-button card-pay" type="button" onClick={() => void beginPayment("card")} disabled={!canTender}>
                  <span><Icon name="card" /></span><div><strong>Pay by card</strong><small>Tap or insert</small></div><Icon name="chevron" />
                </button>
                <button className="pay-button cash-pay" type="button" onClick={() => void beginPayment("cash")} disabled={!canTender}>
                  <span><Icon name="cash" /></span><div><strong>Exact cash</strong><small>Record full total</small></div><Icon name="chevron" />
                </button>
                <button className="pay-button qr-pay" type="button" onClick={() => void beginPayment("vietnam_qr")} disabled={!canTender}>
                  <span><Icon name="qr" /></span><div><strong>Vietnam QR</strong><small>VCB · MoMo · ZaloPay · ShopeePay</small></div><Icon name="chevron" />
                </button>
              </div>
            )}

            {(paymentState.phase === "unknown" || paymentState.phase === "awaiting-card") && pendingPayment && !paymentBusy && (
              <button className="wide-action attention" type="button" onClick={retrySameAttempt}><Icon name="retry" /> Check the same attempt safely</button>
            )}

            {paymentState.phase === "unknown" && pendingCheckout && !pendingPayment && !paymentBusy && (
              <button className="wide-action attention" type="button" onClick={retryCheckout}><Icon name="retry" /> Recover the same checkout safely</button>
            )}

            {paymentState.phase === "declined" && pendingPayment && !paymentBusy && (
              <div className="retry-actions">
                <button type="button" onClick={() => retryDeclined("card")}><Icon name="card" /> Try card again</button>
                <button type="button" onClick={() => retryDeclined("cash")}><Icon name="cash" /> Take exact cash</button>
                <button type="button" onClick={() => retryDeclined("vietnam_qr")}><Icon name="qr" /> New Vietnam QR</button>
              </div>
            )}

            {paymentState.phase === "captured" && (
              <button className="wide-action new-sale" type="button" onClick={() => void newSale()} disabled={cartBusy}><Icon name="plus" /> Start new sale</button>
            )}

            <div className="payment-footnote">
              <Icon name="lock" />
              <span>Payment details stay with the simulated provider.<small>Cards and Vietnam QR are sandbox-only in this build.</small></span>
            </div>
          </div>
        </aside>
      </main>

      {notice && <div className="toast" role="status"><Icon name="alert" /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification"><Icon name="close" /></button></div>}
      {receipt && <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
