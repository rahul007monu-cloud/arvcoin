import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AssetIcon, GlassCard, PrimaryButton, Screen } from "@/components";
import { Header } from "./pay";
import { cryptoAssets, formatInr, stockAssets } from "@/mockData";
import { useStore } from "@/store";
import { colors, radius } from "@/theme";

export default function Choose() {
  const router = useRouter();
  const { prices } = useStore();
  const { amount, method } = useLocalSearchParams<{ amount: string; method: string }>();
  const [tab, setTab] = useState<"crypto" | "stock">("crypto");
  const [selected, setSelected] = useState<string | null>(null);

  const amt = parseInt(amount || "0", 10);
  const list = tab === "crypto" ? cryptoAssets : stockAssets;
  const stockLocked = tab === "stock"; // crypto-first: stocks come after partner KYC

  return (
    <Screen>
      <Header title="Choose investment" onBack={() => router.back()} />

      <View style={{ paddingHorizontal: 20, marginBottom: 6 }}>
        <Text style={styles.amtLine}>
          Investing <Text style={{ color: colors.mint, fontWeight: "800" }}>{formatInr(amt)}</Text> via {method}
        </Text>
      </View>

      {/* tabs */}
      <View style={styles.tabs}>
        <Tab label="Crypto" active={tab === "crypto"} onPress={() => { setTab("crypto"); setSelected(null); }} />
        <Tab label="Stocks & MF" active={tab === "stock"} onPress={() => { setTab("stock"); setSelected(null); }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}>
        {stockLocked && (
          <GlassCard style={styles.lockCard} gradientBg>
            <Ionicons name="time-outline" size={22} color={colors.cyan} />
            <Text style={styles.lockTitle}>Stocks & MF — coming soon</Text>
            <Text style={styles.lockSub}>
              Broker & smallcase partner onboarding chal raha hai (SEBI-compliant). Tab tak crypto se
              invest karo — same app, same flow.
            </Text>
          </GlassCard>
        )}

        <View style={{ gap: 12, opacity: stockLocked ? 0.45 : 1 }}>
          {list.map((a) => {
            const p = prices[a.id] ?? a;
            const isSel = selected === a.id;
            const rowUp = p.change24h >= 0;
            return (
              <Pressable
                key={a.id}
                disabled={stockLocked}
                onPress={() => setSelected(a.id)}
              >
                <GlassCard
                  style={[
                    styles.assetCard,
                    isSel && { borderColor: colors.cyan, borderWidth: 1.5 },
                  ]}
                >
                  <AssetIcon glyph={a.glyph} color={a.color} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.name}>{a.name}</Text>
                    <Text style={styles.sub}>{a.symbol}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={styles.name}>{formatInr(p.priceInr)}</Text>
                    <Text style={{ color: rowUp ? colors.up : colors.down, fontSize: 12, fontWeight: "700" }}>
                      {rowUp ? "+" : ""}
                      {p.change24h.toFixed(1)}%
                    </Text>
                  </View>
                  {isSel && (
                    <View style={styles.check}>
                      <Ionicons name="checkmark" size={14} color="#050614" />
                    </View>
                  )}
                </GlassCard>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <PrimaryButton
          label="Review order"
          disabled={!selected || stockLocked}
          onPress={() =>
            router.push({
              pathname: "/confirm",
              params: { amount, method, assetId: selected! },
            })
          }
        />
      </View>
    </Screen>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.tab, active && { backgroundColor: colors.card, borderColor: colors.strokeStrong }]}
      onPress={onPress}
    >
      <Text style={{ color: active ? colors.text : colors.muted, fontWeight: "700", fontSize: 14 }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  amtLine: { color: colors.muted, fontSize: 14 },
  tabs: {
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 20,
    marginVertical: 14,
    padding: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  tab: {
    flex: 1,
    height: 42,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  lockCard: { alignItems: "flex-start", gap: 6, marginBottom: 16, borderColor: colors.strokeStrong },
  lockTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  lockSub: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  assetCard: { flexDirection: "row", alignItems: "center", padding: 14 },
  name: { color: colors.text, fontSize: 15, fontWeight: "700" },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  check: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.mint,
    alignItems: "center",
    justifyContent: "center",
  },
});
