# outsystems-mcp-installer

Aplikasi Windows dengan installer pemilih folder, system tray, dashboard konfigurasi, dan CLI untuk menyimpan beberapa server OutSystems MCP. Mendukung dua jenis server:

| Jenis | Sumber | URL | Auth |
| :-- | :-- | :-- | :-- |
| `odc` | OutSystems Developer Cloud, di-host tenant | `https://<tenant>/mcp` | OAuth + Dynamic Client Registration |
| `o11` | Service Studio 11.55.91+, proses lokal | `http://127.0.0.1:41820/mcp` (port bisa geser) | Approval prompt di Service Studio |

Server disimpan di satu registry. Sebagian bisa dipilih, sisanya tetap tersimpan. `Apply` menulis server yang dipilih ke config client; aplikasi ini tidak mengatur koneksi atau sesi OAuth client.

## Requirements

- Node.js 20 atau lebih baru.
- Installer dan tray: Windows dengan Windows PowerShell, WinForms, dan Windows Script Host (`wscript.exe`/VBScript) tersedia. Node.js tidak dibundel.
- Untuk `o11`: Service Studio 11.55.91+, modul terbuka, dan MCP server sudah di-start dari **Edit > MCP Configuration**.
- Untuk `claude-desktop`: Node.js dengan `npx` (installer memakai proxy `mcp-remote@0.14.3`).

## Instalasi Windows

1. Jalankan `Install.cmd` dari folder source.
2. Pilih lokasi instalasi dengan **Browse...** atau masukkan full path. Gunakan folder baru atau kosong di luar folder source.
3. Tekan **Install**. File aplikasi disalin ke folder tersebut sebelum detail server diminta. Folder berisi file tidak ditimpa.
4. Dashboard terbuka di browser. Isi nama server dan tenant ODC atau port O11, lalu tekan **Choose clients**.
5. Pilih scope dan client. Periksa setiap path config sebelum **Add server and apply**.

Scope **Project** membutuhkan folder source project yang sudah ada. Folder aplikasi dan subfoldernya ditolak. Path project tidak diisi otomatis pada instalasi baru.

Untuk instalasi tanpa membuka dashboard:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\windows\Install.ps1 -Destination "D:\Apps\OutSystems MCP" -NoLaunch
```

Jalankan `Launch.vbs` dari folder hasil instalasi untuk membuka aplikasi. Installer menyimpan path absolut Node.js di `installation.json`; jika Node.js pindah, instal ulang ke folder baru.

### Tray dan lifecycle

- Sebelum server pertama tersimpan, jendela **OutSystems MCP setup** menyediakan **Open setup**. Menutup jendela ini menghentikan aplikasi.
- Setelah server pertama tersimpan, jendela setup disembunyikan dan ikon muncul di system tray, kadang di bagian ikon tersembunyi Windows.
- Klik dua kali ikon, atau pilih **Open dashboard** dari menu ikon, untuk membuka konfigurasi lagi.
- Tooltip menunjukkan jumlah server tersimpan dan dipilih, bukan jumlah koneksi atau sesi login.
- Menutup tab browser tidak menghentikan tray. **Quit OutSystems MCP** menghentikan tray dan backend lokal.
- Membuka `Launch.vbs` lagi dari instalasi yang sama menggunakan dashboard yang sedang berjalan, bukan membuat backend kedua.
- Ikon memakai ikon aplikasi bawaan Windows sebagai placeholder, bukan logo final OutSystems.

Dashboard hanya listen di `127.0.0.1` dengan port lokal yang dipilih saat launch. Metadata sementara `data\desktop.json` berisi PID dan URL; shutdown normal menghapusnya. Registry instalasi berada di `<folder aplikasi>\data\servers.json`.

Tidak ada service, auto-start Windows, shortcut Start menu, atau uninstaller otomatis. Untuk menghapus instalasi, bersihkan entri client yang tidak lagi dibutuhkan melalui dashboard dan **Apply**, pilih **Quit**, lalu hapus folder aplikasi sendiri. Cache OAuth milik client tidak ikut dihapus.

## Dashboard

- **Add server** menyimpan tenant ODC atau port dari **Edit > MCP Configuration** di Service Studio. Menyimpan server tidak menjalankan endpoint check.
- Switch **Selected** dan **Quick select** menyimpan pilihan; tekan **Apply to clients** untuk menulis config.
- Memilih atau menambahkan ODC mengganti pilihan ODC sebelumnya, tetapi mempertahankan pilihan O11. CLI tetap dapat memilih beberapa ODC sekaligus.
- **Change clients** menyimpan client, scope, dan folder project tujuan. Perubahan ini baru ditulis saat **Apply**.
- **Remove** menghapus server dari registry. Entri client baru dibersihkan pada **Apply** berikutnya, termasuk setelah server terakhir dihapus.
- **Check** dan **Check endpoints** mengirim request HTTP tanpa kredensial client. `2xx`, `401`, atau `403` membuktikan endpoint menjawab, bukan handshake MCP atau status login client.
- Jika satu config gagal ditulis, dashboard menunjukkan error per client. Config yang berhasil tetap ditulis; perbaiki config gagal lalu coba **Apply** lagi.

## Pakai CLI

CLI dari source memakai `~/.outsystems-mcp/servers.json` secara default. Agar CLI memakai registry instalasi tray yang sama, set `OMS_HOME` terlebih dahulu:

```powershell
$env:OMS_HOME = 'D:\Apps\OutSystems MCP\data'
node 'D:\Apps\OutSystems MCP\bin\oms.js' list
```

Contoh dari source dengan registry default:

```powershell
cd outsystems-mcp-installer
node bin/oms.js help

# Dua tenant ODC + satu Service Studio lokal
node bin/oms.js add odc outsystems-dev --tenant acme.outsystems.dev
node bin/oms.js add odc outsystems-prod --tenant https://acme-prod.outsystems.dev/mcp
node bin/oms.js add o11 servicestudio

# Pilih server, lalu tulis ke config project pada working directory
node bin/oms.js use outsystems-dev servicestudio
node bin/oms.js apply --clients opencode,cursor,vscode --scope project

# Cek balasan endpoint tanpa membaca sesi login client
node bin/oms.js doctor
```

Supaya bisa dipanggil sebagai `oms`:

```powershell
npm link
oms list
```

## Perintah

| Perintah | Fungsi |
| :-- | :-- |
| `oms add odc <name> --tenant <host>` | Tambah server ODC. Skema, `www.`, path, dan query dibuang otomatis. |
| `oms add o11 <name> [--url <url>]` | Tambah server Service Studio. Default `http://127.0.0.1:41820/mcp`. Hanya loopback. |
| `oms add ... --no-activate` | Simpan tanpa memasukkan ke set aktif. |
| `oms add ... --force` | Timpa entri dengan nama yang sama. |
| `oms list` | Tampilkan registry, jenis, status aktif, URL. |
| `oms use <name...>` | Ganti seluruh set aktif. |
| `oms remove <name>` | Hapus dari registry. Pakai `oms apply` untuk membersihkan config client; pruning aktif secara default. |
| `oms apply` | Tulis server terpilih. Hapus nama yang tidak dipilih atau sudah dihapus dari registry; nama lain tetap ada. File lama disalin ke `.bak` sebelum ditulis. |
| `oms apply --dry-run` | Tampilkan perubahan tanpa menulis. |
| `oms apply --scope user\|project` | Override scope tersimpan. `--scope project` eksplisit memakai working directory; tanpa override, gunakan folder project yang disimpan dashboard. Default tanpa settings: `user`. |
| `oms apply --clients a,b` | Override client tersimpan. Default tanpa settings: `opencode`. Pilihan: `opencode`, `claude`, `cursor`, `vscode`, `kiro`, `claude-desktop`. |
| `oms apply --no-prune` | Pertahankan entri lama di config. Client dapat memuatnya setelah reload; installer tidak mengontrol koneksinya. |
| `oms doctor [--all]` | POST `initialize` tanpa kredensial ke server terpilih, atau semua dengan `--all`. Tidak membaca sesi OAuth client. |
| `oms path` | Lokasi registry. |
| `oms ui [--port 4780] [--no-open]` | Dashboard dari source, tanpa tray Windows. Hentikan dengan Ctrl+C. |

Nama server berisi 1 sampai 64 karakter: huruf kecil, angka, `-`, `_`, diawali huruf atau angka. Nama yang sama dipakai di semua client. Pilih nama unik; entri client dengan nama tersebut dapat diganti saat Apply.

## Config client

| Client | Scope | Lokasi default | Key | Bentuk entri |
| :-- | :-- | :-- | :-- | :-- |
| OpenCode | user | `~/.config/opencode/opencode.json` | `mcp.servers` (v2) atau `mcp` (v1) | `{ "type": "remote", "url": ... }` |
| OpenCode | project | `<project>/opencode.json` | sama | sama |
| Claude Code | project | `<project>/.mcp.json` | `mcpServers` | `{ "type": "http", "url": ... }` |
| Cursor | user / project | `~/.cursor/mcp.json` / `<project>/.cursor/mcp.json` | `mcpServers` | `{ "url": ... }` |
| VS Code Copilot | user / project | `%APPDATA%\Code\User\mcp.json` / `<project>/.vscode/mcp.json` | `servers` | `{ "type": "http", "url": ... }` |
| Kiro | user | `~/.kiro/settings/mcp.json` | `mcpServers` | `{ "type": "http", "url": ... }` |
| Claude Desktop | user | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` | `{ "command": "cmd", "args": ["/c", "npx mcp-remote@0.14.3 <url>"] }` |

OpenCode dideteksi otomatis: kalau `mcp.servers` sudah ada, installer menulis ke sana (skema v2). Kalau `mcp` berisi entri dengan `type` langsung, installer menulis ke `mcp` (skema v1). File baru selalu dibuat dengan skema v2.

`<project>` adalah folder source yang dipilih di dashboard, atau working directory ketika CLI menerima `--scope project`. `OPENCODE_CONFIG` dapat mengubah path OpenCode untuk scope user.

`oms apply` tidak mengubah key lain di file. Kalau file berisi komentar (JSONC), JSON tidak valid, atau struktur config bukan object, penulisan client tersebut dihentikan dan file asli tetap ada. Backup `.bak` berisi versi sebelum penulisan terakhir, bukan seluruh riwayat. Untuk rollback, tutup atau reload client sesuai kebutuhan, pulihkan `.bak` secara manual, lalu reload config.

## Ganti tenant atau pilih beberapa tenant

Default dashboard: **satu ODC dipilih + O11 sesuai kebutuhan**. Server ODC kedua tetap tersimpan, tetapi tidak ditulis ke config.

```powershell
# Kerja di tenant A
oms use outsystems-dev servicestudio
oms apply

# Pindah ke tenant B. Entri tenant A hilang dari config; cache OAuth client tidak disentuh.
oms use outsystems-prod servicestudio
oms apply
```

`Apply` menghapus entri registry yang tidak dipilih dari config. Client yang sudah berjalan bisa tetap memakai config atau koneksi lama sampai reload/restart. Pergantian tenant tidak otomatis memutus koneksi client.

Installer tidak menghapus cache OAuth client. Memilih tenant lagi tetap dapat meminta login baru karena token kedaluwarsa, dicabut, atau kebijakan tenant/client. Kelola sign-in dan logout di client, bukan dashboard. Pada versi OpenCode yang menyediakan perintah ini:

```powershell
opencode mcp logout outsystems-prod
```

CLI dapat menulis beberapa tenant ketika memang dibutuhkan dalam satu project:

```powershell
oms use outsystems-dev outsystems-prod servicestudio
oms apply
```

Reload client setelah Apply. Sebut nama server dan tenant tujuan di prompt untuk mengurangi risiko memakai tenant yang salah.

## Catatan platform

**ODC**
- Sign-in, refresh token, dan logout dijalankan client. Installer tidak menyimpan token, `client_id`, atau callback port.
- Tray tetap berjalan tidak berarti ODC tetap login. Tidak ada keep-alive OAuth atau jaminan mencegah auto-logout.
- `401`/`403` dari `oms doctor` menunjukkan balasan HTTP tanpa kredensial; hasil ini tidak menentukan apakah client sudah login.
- Waktu munculnya sign-in bergantung pada client dan versinya. Periksa status autentikasi langsung di client.
- Jika client melaporkan `403 tenant_not_allowed`, cek akses tenant dan kebijakan server dengan administrator OutSystems. Endpoint check ini tidak membaca body error tersebut.

**O11**
- Server hanya hidup selama Service Studio jalan dan MCP server di-start per sesi dari modul yang dibuka.
- Port default `41820`. Kalau sibuk, Service Studio mencoba port berikutnya sampai 20 kali. Ambil URL dari dialog, lalu:
  `oms add o11 servicestudio --url http://127.0.0.1:41821/mcp`
- Koneksi pertama dari tiap agent memunculkan approval prompt di Service Studio.
- Endpoint hanya listen di `127.0.0.1`. Installer menolak host non-loopback.
- Satu Service Studio = satu modul. Untuk dua modul sekaligus, jalankan dua instance dengan port berbeda dan daftarkan dua nama.

## Tidak termasuk

- Instalasi skill/instruction OutSystems (`SKILL.md`). Skill ODC sudah tersedia terpisah; O11 punya repo `outsystems11-mcp`.
- Header `X-OutSystems-Plugin-Version` untuk Kiro/Cursor. Tambahkan manual kalau perlu versi plugin tertentu.
- Rotasi/penyimpanan token.
- Jaminan login ODC bertahan saat idle, pencegahan logout, atau pengendalian koneksi client.
- Instalasi Node.js, auto-start Windows, dan logo tray final.
- Start/stop Service Studio MCP server. Itu hanya bisa dari UI Service Studio.

## Test

```powershell
npm test
node --test --experimental-test-coverage
```

Test otomatis menggunakan registry dan config sementara. Cakupan meliputi instalasi ke path terpisah, proteksi overwrite, validasi API, lifecycle backend, schema enam client, pruning, serta logika form dan fokus UI. Test tidak membuktikan interaksi folder picker/tray, pembacaan screen reader, reload client nyata, login ODC, refresh token, atau perilaku long-idle. Verifikasi hal tersebut secara manual pada target Windows dan client yang digunakan.

## Troubleshooting

| Gejala | Sebab dan perbaikan |
| :-- | :-- |
| `oms doctor` bilang O11 `connection refused` | MCP server belum di-start. Buka modul di Service Studio, **Edit > MCP Configuration > Start MCP Server**, lalu salin URL dari dialog. |
| O11 connect tapi port beda | Port `41820` sibuk. Daftarkan URL yang ditampilkan dialog, jangan asumsikan default. |
| `cannot parse <file>` | File config berisi komentar atau JSON tidak valid. Perbaiki manual; installer tidak menulis ulang file yang tidak bisa dibaca. |
| Perubahan tidak terlihat di client | Periksa path config yang ditulis, lalu reload/restart client dengan cara yang sesuai versinya. |
| Endpoint check tetap ODC 401 setelah sign-in | Check tidak memakai kredensial client. Periksa login di client, bukan hasil check dashboard. |
| ODC logout setelah idle | Periksa token, kebijakan sesi tenant, dan mekanisme refresh client. Tray tidak mempertahankan sesi OAuth. |
| Ikon tray belum muncul | Simpan server pertama, lalu periksa ikon tersembunyi Windows. Menutup setup sebelum menyimpan menghentikan aplikasi. |
| Project config mengarah ke lokasi salah | Pilih **Change clients**, scope **Project**, dan folder source yang benar, lalu Apply. |
| Instalasi ditolak karena folder tidak kosong | Pilih folder baru atau kosong. Installer tidak menimpa instalasi lama. |
