import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AssetIcon, GlassCard, PrimaryButton, Screen } from "@/components";
import { Header } from "./pay";
import { formatInr, formatUnits, getAsset } from "@/mockData";
import { useStore } from "@/store";
import { colors } from "@/theme";

export default function Confirm() {
  const router = useRouter();
  const { prices, invest } = useStore();
  const { amount, method, assetId } = useLocalSearchParams<{
    amount: string;
    method: string;
    assetId: string;
  }>();
  const [loading, setLoading] = useState(false);

  const amt = parseInt(amount || "0", 10);
  const asset = prices[assetId] ?? getAsset(assetId)!;
  const fee = Math.max(0, Math.round(amt * 0.005)); // 0.5% mock partner fee
  const investable = amt - fee;
  const units = investable / asset.priceInr;

  const handlePay = () => {
    setLoading(true);
    // simulate payment + partner order placement
    setTimeout(() => {
      const txn = invest(assetId, investable, method as "UPI" | "QR");
      setLoading(false);
      router.replace({
        pathname: "/success",
        params: { assetId, amount: String(investable), units: String(txn.units), method },
      });
    }, 1600);
  };

  return (
    <Screen>
      <Header title="Review order" onBack={() => router.back()} />

      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        <GlassCard gradientBg style={styles.hero}>
          <AssetIcon glyph={asset.glyph} color={asset.color} size={56} />
          <Text style={styles.assetName}>{asset.name}</Text>
          <Text style={styles.assetSub}>
            {formatInr(asset.priceInr)} / {asset.symbol}
          </Text>
        </GlassCard>

        <GlassCard style={{ marginTop: 16, gap: 2 }}>
          <Row label="You pay" value={formatInr(amt)} />
          <Divider />
          <Row label="Partner fee (0.5%)" value={formatInr(fee)} muted />
          <Divider />
          <Row label="Invested amount" value={formatInr(investable)} />
          <Divider />
          <Row label={`Est. ${asset.symbol}`} value={`${formatUnits(units)} ${asset.symbol}`} />
          <Divider />
          <Row label="Method" value={method as string} />
        </GlassCard>

        <View style={styles.note}>
          <Ionicons name="lock-closed" size={14} color={colors.mint} />
          <Text style={styles.noteTxt}>
            {asset.type === "crypto"
              ? "Crypto seedha tumhare wallet me jaayega (non-custodial, via Onramp.money)."
              : "Order tumhare demat/folio me place hoga (via broker/smallcase partner)."}
          </Text>
        </View>

        <PrimaryButton
          label={loading ? "Processing…" : `Pay ${formatInr(amt)}`}
          loading={loading}
          onPress={handlePay}
          style={{ marginTop: "auto", marginBottom: 12 }}
        />
      </View>
    </Screen>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, muted && { color: colors.muted }]}>{value}</Text>
    </View>
  );
}
function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: 6, paddingVertical: 24 },
  assetName: { color: colors.text, fontSize: 20, fontWeight: "800", marginTop: 6 },
  assetSub: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12 },
  rowLabel: { color: colors.muted, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: "700" },
  divider: { height: 1, backgroundColor: colors.stroke },
  note: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 16, paddingHorizontal: 4 },
  noteTxt: { color: colors.muted, fontSize: 12, flexShrink: 1, lineHeight: 17 },
});
