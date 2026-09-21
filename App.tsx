import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
  StatusBar,
  Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { WebView } from 'react-native-webview';

const logoMark = require('./assets/logo-mark.png');

type PanelType = 'openpanel' | 'openadmin';

type ServerMeta = {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  panel: PanelType;
};

const SERVERS_KEY = 'oa_servers_meta';
const pwKey = (id: string) => `oa_pw_${id}`;

// strip trailing slash so we can safely concat "${baseUrl}${path}"
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

async function loadServers(): Promise<ServerMeta[]> {
  const raw = await SecureStore.getItemAsync(SERVERS_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as ServerMeta[];
    // servers saved before panel-type support default to openadmin (the only type back then)
    return list.map((s) => ({ ...s, panel: s.panel ?? 'openadmin' }));
  } catch {
    return [];
  }
}

async function saveServers(servers: ServerMeta[]) {
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers));
}

const BACKUP_VERSION = 1;

// Passwords travel in plain text inside this file, same as SecureStore holds them
// on-device -- fine for a user-controlled backup, but callers must warn before sharing.
type BackupPayload = {
  version: number;
  exportedAt: string;
  servers: (ServerMeta & { password: string })[];
};

async function exportServers(servers: ServerMeta[]): Promise<void> {
  const withPasswords = await Promise.all(
    servers.map(async (s) => ({ ...s, password: (await SecureStore.getItemAsync(pwKey(s.id))) ?? '' }))
  );
  const payload: BackupPayload = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    servers: withPasswords,
  };
  const file = new File(Paths.cache, `openpanel-servers-${Date.now()}.json`);
  file.write(JSON.stringify(payload, null, 2));
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Export servers' });
}

// Merges by (panel, baseUrl, username) so re-importing the same backup, or one that
// overlaps with servers already on this device, doesn't create duplicate entries.
async function importServers(existing: ServerMeta[]): Promise<{ servers: ServerMeta[]; added: number }> {
  const picked = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
  if (picked.canceled) return { servers: existing, added: 0 };

  const raw = await new File(picked.assets[0].uri).text();
  let payload: BackupPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!Array.isArray(payload?.servers)) {
    throw new Error('That file does not look like an OpenPanel server backup.');
  }

  const seen = new Set(existing.map((s) => `${s.panel}:${s.baseUrl}:${s.username}`));
  const next = [...existing];
  let added = 0;
  for (const [i, s] of payload.servers.entries()) {
    if (!s?.baseUrl || !s?.username || (s.panel !== 'openpanel' && s.panel !== 'openadmin')) continue;
    const key = `${s.panel}:${s.baseUrl}:${s.username}`;
    if (seen.has(key)) continue;
    const id = `${Date.now()}_${i}`;
    next.push({ id, name: s.name || s.baseUrl, baseUrl: s.baseUrl, username: s.username, panel: s.panel });
    await SecureStore.setItemAsync(pwKey(id), s.password || '');
    seen.add(key);
    added++;
  }
  await saveServers(next);
  return { servers: next, added };
}

type ServerStatus = 'checking' | 'online' | 'offline';

// GET /login is an unauthenticated page on both OpenPanel and OpenAdmin --
// cheap way to know a server is reachable before the user taps in to log in.
async function checkServerStatus(server: ServerMeta): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${server.baseUrl}/login`, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// OpenPanel has no SSO handoff like OpenAdmin's, so adding one is validated
// upfront instead: log in for a real API token, then probe a feature-gated
// endpoint, since login itself succeeds even when API access is disabled.
async function testOpenPanelConnection(baseUrl: string, username: string, password: string): Promise<void> {
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) {
    if (loginBody?.twofa_required) {
      throw new Error("This account has 2FA enabled, which isn't supported here yet. Disable 2FA to add it for now.");
    }
    throw new Error(loginBody?.error || `Login failed (HTTP ${loginRes.status})`);
  }
  const token = loginBody?.token;
  if (!token) throw new Error('OpenPanel did not return an API token.');

  const checkRes = await fetch(`${baseUrl}/api/sites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (checkRes.status === 403) {
    const checkBody = await checkRes.json().catch(() => ({}));
    if ((checkBody?.hint || '').toLowerCase().includes('api access')) {
      throw new Error(
        "API access is not enabled for this account. Check Account > API Reference in your OpenPanel account " +
          "— if it's not there, contact your hosting provider to enable API access."
      );
    }
    throw new Error(checkBody?.error || 'Access denied.');
  }
  if (!checkRes.ok) {
    throw new Error(`Could not verify API access (HTTP ${checkRes.status}).`);
  }
}

type Screen =
  | { name: 'list' }
  | { name: 'add' }
  | { name: 'backup' }
  | { name: 'connecting'; server: ServerMeta }
  | { name: 'webview'; server: ServerMeta; url: string };

export default function App() {
  const [servers, setServers] = useState<ServerMeta[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({});
  const [screen, setScreen] = useState<Screen>({ name: 'list' });

  const refreshStatuses = useCallback((list: ServerMeta[]) => {
    setStatuses((prev) => {
      const next = { ...prev };
      list.forEach((s) => (next[s.id] = 'checking'));
      return next;
    });
    list.forEach((server) => {
      checkServerStatus(server).then((ok) => {
        setStatuses((prev) => ({ ...prev, [server.id]: ok ? 'online' : 'offline' }));
      });
    });
  }, []);

  useEffect(() => {
    loadServers().then((list) => {
      setServers(list);
      refreshStatuses(list);
    });
  }, [refreshStatuses]);

  const handleAddServer = useCallback(
    async (name: string, rawBaseUrl: string, username: string, password: string, panel: PanelType) => {
      const baseUrl = normalizeBaseUrl(rawBaseUrl);
      if (panel === 'openpanel') {
        await testOpenPanelConnection(baseUrl, username, password);
      }
      const id = `${Date.now()}`;
      const entry: ServerMeta = { id, name, baseUrl, username, panel };
      const next = [...servers, entry];
      await saveServers(next);
      await SecureStore.setItemAsync(pwKey(id), password);
      setServers(next);
      setScreen({ name: 'list' });
      refreshStatuses([entry]);
    },
    [servers]
  );

  const handleDeleteServer = useCallback(
    async (id: string) => {
      const next = servers.filter((s) => s.id !== id);
      await saveServers(next);
      await SecureStore.deleteItemAsync(pwKey(id));
      setServers(next);
    },
    [servers]
  );

  const handleConnect = useCallback(async (server: ServerMeta) => {
    if (server.panel === 'openpanel') {
      // No SSO handoff on OpenPanel yet -- open its normal login page and let
      // the user sign in there, same as they would in a regular browser.
      setScreen({ name: 'webview', server, url: `${server.baseUrl}/login` });
      return;
    }
    setScreen({ name: 'connecting', server });
    try {
      const password = await SecureStore.getItemAsync(pwKey(server.id));
      const res = await fetch(`${server.baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: server.username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        // A genuine credential/account problem -- surface it instead of silently falling back.
        throw new Error(body?.error || `Login failed (HTTP ${res.status})`);
      }
      const loginPath = res.ok ? body?.login_path : undefined;
      if (!loginPath) {
        // Quick-login isn't available -- most likely an OpenAdmin build old enough to predate
        // the /api/login SSO handoff (or its CSRF exemption), so it rejects this request for
        // reasons unrelated to the password. Fall back to the normal login page instead of a
        // dead end, same as the no-SSO-yet path for OpenPanel above.
        setScreen({ name: 'webview', server, url: `${server.baseUrl}/login` });
        return;
      }
      setScreen({ name: 'webview', server, url: `${server.baseUrl}${loginPath}` });
    } catch (err: any) {
      Alert.alert('Could not connect', err?.message || String(err));
      setScreen({ name: 'list' });
    }
  }, []);

  const handleExport = useCallback(async () => {
    await exportServers(servers);
  }, [servers]);

  const handleImport = useCallback(async () => {
    const { servers: next, added } = await importServers(servers);
    setServers(next);
    if (added > 0) refreshStatuses(next.slice(next.length - added));
    return added;
  }, [servers, refreshStatuses]);

  let content: React.ReactNode;

  if (screen.name === 'add') {
    content = <AddServerScreen onCancel={() => setScreen({ name: 'list' })} onSave={handleAddServer} />;
  } else if (screen.name === 'backup') {
    content = (
      <BackupScreen onBack={() => setScreen({ name: 'list' })} onExport={handleExport} onImport={handleImport} />
    );
  } else if (screen.name === 'connecting') {
    content = (
      <SafeAreaView style={styles.centerScreen}>
        <ActivityIndicator size="large" />
        <Text style={styles.mutedText}>Connecting to {screen.server.name}…</Text>
      </SafeAreaView>
    );
  } else if (screen.name === 'webview') {
    content = (
      <SafeAreaView style={styles.webviewSafeArea} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.webviewHeader}>
          <TouchableOpacity
            onPress={() => {
              setScreen({ name: 'list' });
              refreshStatuses(servers);
            }}
            style={styles.webviewCloseBtn}
          >
            <Text style={styles.webviewCloseText}>‹ Servers</Text>
          </TouchableOpacity>
          <Text style={styles.webviewTitle} numberOfLines={1}>
            {screen.server.name}
          </Text>
          <View style={styles.webviewCloseBtn} />
        </View>
        <WebView
          source={{ uri: screen.url }}
          style={styles.webview}
          sharedCookiesEnabled
          startInLoadingState
          renderLoading={() => (
            <View style={styles.webviewLoading}>
              <ActivityIndicator size="large" />
            </View>
          )}
        />
      </SafeAreaView>
    );
  } else {
    content = (
      <ServerListScreen
        servers={servers}
        statuses={statuses}
        onConnect={handleConnect}
        onDelete={handleDeleteServer}
        onAdd={() => setScreen({ name: 'add' })}
        onBackup={() => setScreen({ name: 'backup' })}
      />
    );
  }

  return <SafeAreaProvider>{content}</SafeAreaProvider>;
}

function StatusDot({ status }: { status: ServerStatus | undefined }) {
  const color =
    status === 'online' ? '#2ecc71' : status === 'offline' ? '#e74c3c' : '#ccc';
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

function ServerListScreen({
  servers,
  statuses,
  onConnect,
  onDelete,
  onAdd,
  onBackup,
}: {
  servers: ServerMeta[];
  statuses: Record<string, ServerStatus>;
  onConnect: (s: ServerMeta) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onBackup: () => void;
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.headerRow}>
        <Image source={logoMark} style={styles.headerLogo} resizeMode="contain" />
        <Text style={styles.header}>OpenPanel</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={onBackup}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Backup and restore servers"
        >
          <Text style={styles.headerBackupIcon}>💾</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={servers}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.mutedText}>No servers yet. Add one to get started.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.serverRow} onPress={() => onConnect(item)}>
            <StatusDot status={statuses[item.id]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.serverName}>{item.name}</Text>
              <Text style={styles.serverSub}>
                {item.username}@{item.baseUrl.replace(/^https?:\/\//, '')}
              </Text>
              <Text style={styles.serverPanelLabel}>
                {item.panel === 'openpanel' ? 'OpenPanel account' : 'OpenAdmin server'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() =>
                Alert.alert('Remove server', `Remove ${item.name}?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: () => onDelete(item.id) },
                ])
              }
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.deleteText}>Remove</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={styles.primaryButton} onPress={onAdd}>
        <Text style={styles.primaryButtonText}>+ Add server</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function PanelTypeOption({
  label,
  selected,
  accentColor,
  onPress,
}: {
  label: string;
  selected: boolean;
  accentColor: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.panelOption, selected && { borderColor: accentColor }]}
      onPress={onPress}
    >
      <Image
        source={logoMark}
        style={[styles.panelOptionLogo, { tintColor: accentColor }]}
        resizeMode="contain"
      />
      <Text style={[styles.panelOptionLabel, selected && { color: accentColor }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function AddServerScreen({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (
    name: string,
    baseUrl: string,
    username: string,
    password: string,
    panel: PanelType
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [panel, setPanel] = useState<PanelType>('openpanel');
  const [panelTouched, setPanelTouched] = useState(false);

  // Auto-pick the panel type from the port the user typed (2083 -> OpenPanel,
  // 2087 -> OpenAdmin's default), unless they've already picked one themselves.
  useEffect(() => {
    if (panelTouched) return;
    if (/:2087\b/.test(baseUrl)) setPanel('openadmin');
    else if (/:2083\b/.test(baseUrl)) setPanel('openpanel');
  }, [baseUrl, panelTouched]);

  const selectPanel = (p: PanelType) => {
    setPanel(p);
    setPanelTouched(true);
  };

  const canSave = name.trim() && baseUrl.trim() && username.trim() && password.length > 0 && !saving;

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.header}>Add server</Text>
      <View style={styles.form}>
        <Text style={styles.label}>Type</Text>
        <View style={styles.panelPickerRow}>
          <PanelTypeOption
            label="OpenPanel"
            accentColor="#2e7dd7"
            selected={panel === 'openpanel'}
            onPress={() => selectPanel('openpanel')}
          />
          <PanelTypeOption
            label="OpenAdmin"
            accentColor="#111"
            selected={panel === 'openadmin'}
            onPress={() => selectPanel('openadmin')}
          />
        </View>

        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="My server"
          placeholderTextColor="#999"
        />

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="panel.example.com:2083 (OpenPanel) or :2087 (OpenAdmin)"
          placeholderTextColor="#999"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
        />

        <Text style={styles.label}>Username</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>Password</Text>
        <View style={styles.passwordRow}>
          <TextInput
            style={[styles.input, styles.passwordInput]}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={styles.passwordToggle}
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.passwordToggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, !canSave && styles.primaryButtonDisabled]}
          disabled={!canSave}
          onPress={async () => {
            setSaving(true);
            try {
              await onSave(name.trim(), baseUrl, username.trim(), password, panel);
            } catch (err: any) {
              Alert.alert('Could not add server', err?.message || String(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Text style={styles.primaryButtonText}>
            {saving ? (panel === 'openpanel' ? 'Testing connection…' : 'Saving…') : 'Save'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function BackupScreen({
  onBack,
  onExport,
  onImport,
}: {
  onBack: () => void;
  onExport: () => Promise<void>;
  onImport: () => Promise<number>;
}) {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  const handleExportPress = () => {
    Alert.alert(
      'Export servers',
      'The exported file will contain your saved server addresses, usernames, and passwords in plain text. Keep it somewhere safe, and only share it over a trusted channel.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Export',
          onPress: async () => {
            setBusy('export');
            try {
              await onExport();
            } catch (err: any) {
              Alert.alert('Could not export servers', err?.message || String(err));
            } finally {
              setBusy(null);
            }
          },
        },
      ]
    );
  };

  const handleImportPress = async () => {
    setBusy('import');
    try {
      const added = await onImport();
      Alert.alert(
        'Import complete',
        added > 0 ? `Added ${added} server${added === 1 ? '' : 's'}.` : 'No new servers found in that file.'
      );
    } catch (err: any) {
      Alert.alert('Could not import servers', err?.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.header}>Backup & restore</Text>
      <View style={styles.form}>
        <Text style={styles.mutedText}>
          Export your saved servers and passwords to a file you can keep as a backup or move to another
          device, or import a file exported from this app before.
        </Text>

        <TouchableOpacity
          style={[styles.primaryButton, busy !== null && styles.primaryButtonDisabled]}
          disabled={busy !== null}
          onPress={handleExportPress}
        >
          <Text style={styles.primaryButtonText}>{busy === 'export' ? 'Exporting…' : 'Export servers'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryButton, busy !== null && styles.primaryButtonDisabled]}
          disabled={busy !== null}
          onPress={handleImportPress}
        >
          <Text style={styles.primaryButtonText}>{busy === 'import' ? 'Importing…' : 'Import servers'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={onBack} disabled={busy !== null}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 12 },
  centerScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  headerLogo: { width: 30, height: 30, marginRight: 10 },
  header: { fontSize: 28, fontWeight: '700' },
  headerBackupIcon: { fontSize: 24 },
  mutedText: { color: '#666', marginTop: 12, textAlign: 'center' },
  listContent: { paddingBottom: 12 },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  statusDot: { width: 9, height: 9, borderRadius: 5, marginRight: 12 },
  serverName: { fontSize: 17, fontWeight: '600' },
  serverSub: { fontSize: 13, color: '#777', marginTop: 2 },
  serverPanelLabel: { fontSize: 11, color: '#aaa', marginTop: 2 },
  deleteText: { color: '#c0392b', fontSize: 13 },
  primaryButton: {
    backgroundColor: '#111',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryButton: { alignItems: 'center', paddingVertical: 12 },
  secondaryButtonText: { color: '#555', fontSize: 15 },
  form: { marginTop: 8 },
  panelPickerRow: { flexDirection: 'row', gap: 10 },
  panelOption: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingVertical: 14,
  },
  panelOptionLogo: { width: 28, height: 28, marginBottom: 6 },
  panelOptionLabel: { fontSize: 14, fontWeight: '600', color: '#555' },
  label: { fontSize: 13, color: '#555', marginTop: 14, marginBottom: 6 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111',
  },
  passwordRow: { flexDirection: 'row', alignItems: 'center' },
  passwordInput: { flex: 1 },
  passwordToggle: { marginLeft: 10, paddingVertical: 10, paddingHorizontal: 4 },
  passwordToggleText: { color: '#007aff', fontSize: 14, fontWeight: '600' },
  webviewSafeArea: { flex: 1, backgroundColor: '#fff' },
  webviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  webviewCloseBtn: { minWidth: 70 },
  webviewCloseText: { fontSize: 16, color: '#007aff' },
  webviewTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  webview: { flex: 1 },
  webviewLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
});
