import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import React, { useEffect, useRef } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AssetIcon, GlassCard, Pill, PrimaryButton, Screen } from "@/components";
import { formatInr, formatUnits, getAsset } from "@/mockData";
import { useStore } from "@/store";
import { colors, gradient, radius } from "@/theme";

export default function Home() {
  const router = useRouter();
  const { holdings, prices, txns, invested, currentValue, pnl, pnlPct } = useStore();

  // subtle balance count-up shimmer
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 700, useNativeDriver: true }).start();
  }, [fade]);

  const up = pnl >= 0;

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greet}>Good evening 👋</Text>
            <Text style={styles.brand}>
              arv<Text style={{ color: colors.mint }}>coin</Text>
            </Text>
          </View>
          <View style={styles.avatar}>
            <Ionicons name="person" size={20} color={colors.cyan} />
          </View>
        </View>

        {/* balance card */}
        <Animated.View style={{ opacity: fade, marginHorizontal: 20 }}>
          <LinearGradient
            colors={gradient.card}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.balCard}
          >
            <Text style={styles.balCap}>Total portfolio value</Text>
            <Text style={styles.balValue}>{formatInr(currentValue, 0)}</Text>
            <View style={styles.balRow}>
              <Pill text={`${up ? "▲" : "▼"} ${formatInr(Math.abs(pnl), 0)}`} tone={up ? "up" : "down"} />
              <Pill text={`${up ? "+" : ""}${pnlPct.toFixed(2)}%`} tone={up ? "up" : "down"} />
              <Text style={styles.investedTxt}>Invested {formatInr(invested)}</Text>
            </View>

            {/* mini sparkline */}
            <Sparkline up={up} />
          </LinearGradient>
        </Animated.View>

        {/* quick actions */}
        <View style={styles.actions}>
          <PrimaryButton
            label="Pay & Invest"
            style={{ flex: 1 }}
            onPress={() => router.push("/pay")}
          />
          <Pressable style={styles.iconBtn} onPress={() => router.push("/pay")}>
            <Ionicons name="qr-code-outline" size={24} color={colors.text} />
          </Pressable>
        </View>

        {/* holdings */}
        <SectionTitle title="Your holdings" />
        <View style={{ marginHorizontal: 20, gap: 12 }}>
          {holdings.map((h) => {
            const a = prices[h.assetId] ?? getAsset(h.assetId)!;
            const value = h.units * a.priceInr;
            const rowUp = a.change24h >= 0;
            return (
              <GlassCard key={h.assetId} style={styles.holdRow}>
                <AssetIcon glyph={a.glyph} color={a.color} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.assetName}>{a.name}</Text>
                  <Text style={styles.assetSub}>
                    {formatUnits(h.units)} {a.symbol}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.assetName}>{formatInr(value)}</Text>
                  <Text style={{ color: rowUp ? colors.up : colors.down, fontSize: 12, fontWeight: "700" }}>
                    {rowUp ? "+" : ""}
                    {a.change24h.toFixed(1)}%
                  </Text>
                </View>
              </GlassCard>
            );
          })}
        </View>

        {/* recent activity */}
        <SectionTitle title="Recent activity" />
        <View style={{ marginHorizontal: 20, gap: 10 }}>
          {txns.slice(0, 4).map((t) => {
            const a = getAsset(t.assetId)!;
            return (
              <View key={t.id} style={styles.txnRow}>
                <View style={styles.txnIcon}>
                  <Ionicons name="arrow-up-right" size={16} color={colors.mint} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.assetName}>Invested in {a.name}</Text>
                  <Text style={styles.assetSub}>
                    {t.method} · {new Date(t.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </Text>
                </View>
                <Text style={styles.assetName}>{formatInr(t.amountInr)}</Text>
              </View>
            );
          })}
        </View>

        {/* trust footer */}
        <View style={styles.trust}>
          <Ionicons name="shield-checkmark" size={16} color={colors.mint} />
          <Text style={styles.trustTxt}>
            Powered by regulated partners · Onramp.money · Razorpay · smallcase
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

/** Cheap animated sparkline made of gradient bars. */
function Sparkline({ up }: { up: boolean }) {
  const bars = [40, 55, 48, 70, 62, 85, 78, 96];
  return (
    <View style={styles.spark}>
      {bars.map((b, i) => (
        <LinearGradient
          key={i}
          colors={up ? gradient.brand2 : gradient.down}
          style={{ width: 8, height: `${b}%`, borderRadius: 4, opacity: 0.5 + (i / bars.length) * 0.5 }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 18,
  },
  greet: { color: colors.muted, fontSize: 14 },
  brand: { color: colors.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  balCard: {
    borderRadius: radius.xl,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.strokeStrong,
  },
  balCap: { color: colors.muted, fontSize: 13 },
  balValue: { color: colors.text, fontSize: 42, fontWeight: "800", marginTop: 4, letterSpacing: -1 },
  balRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  investedTxt: { color: colors.muted2, fontSize: 12, marginLeft: "auto" },
  spark: { flexDirection: "row", alignItems: "flex-end", gap: 6, height: 54, marginTop: 18 },
  actions: { flexDirection: "row", gap: 12, marginHorizontal: 20, marginTop: 18, alignItems: "center" },
  iconBtn: {
    width: 54,
    height: 54,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.strokeStrong,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginHorizontal: 20,
    marginTop: 26,
    marginBottom: 14,
  },
  holdRow: { flexDirection: "row", alignItems: "center", padding: 14 },
  assetName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  assetSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  txnRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  txnIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.mint + "1e",
    marginRight: 10,
  },
  trust: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 28,
    paddingHorizontal: 30,
  },
  trustTxt: { color: colors.muted2, fontSize: 12, flexShrink: 1 },
});
