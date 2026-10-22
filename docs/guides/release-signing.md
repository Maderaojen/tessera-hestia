# 後端發布簽章

- 更新：2026-10-18
- 英文版：[release-signing.en.md](release-signing.en.md)

後端版本包改用 RSA／SHA-256 簽署 `SHA256SUMS`，安裝器先驗證
`SHA256SUMS.sig`，才相信 checksum、解壓或執行程式。沒有未簽章備援。
手機 App 更新金鑰是不同的信任用途，不共用。

## 首次配置：下次發布前必須完成

本次檢查沒有找到已配置的正式後端發布公鑰。本次修正沒有產生正式私鑰、
也沒有發布版本；需要維護者執行以下步驟：

1. 在受保護的簽章機器上執行 `umask 077`，再以
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out release-private.pem`
   建立至少 3072 位元的 RSA 私鑰。私鑰放在 repo 外、限制存取並安全備份，
   不可隨版本發布。
2. 用 `openssl pkey -in release-private.pem -pubout -out release-public.pem`
   匯出公鑰。用 `openssl pkey -pubin -in release-public.pem -outform DER | openssl dgst -sha256`
   取得公鑰指紋，透過獨立且可信任的管道公布，並由第二人核對。
3. 使用者先獨立核對指紋，再把公鑰放到 `$HESTIA_HOME/release-public.pem`
   （預設 `~/.local/share/hestia/release-public.pem`），或透過
   `HESTIA_RELEASE_PUBLIC_KEY` 指定可信任的本機檔案。公鑰不可跟版本包一起
   從同個發布來源下載後就直接相信。所在目錄只允許本人寫入。升級保留
   `app/` 外的公鑰。
4. 發布時設定 `HESTIA_RELEASE_SIGNING_KEY` 為受保護的私鑰路徑、
   `HESTIA_RELEASE_PUBLIC_KEY` 為獨立核對的公鑰路徑，再執行發布腳本。
   `--publish` 缺任何金鑰即停止，公私鑰不符也停止。未設定金鑰的 dry run
   僅供檢視，產物不能交給新版安裝器安裝。
5. 發布第一個已簽章版本，並透過可信任的初次安裝管道提供安裝器及公鑰指紋。

舊的未簽章版本不能用新版安裝器安裝。遷移時先配置公鑰，再升級到第一個
已簽章版本。保留獨立核對過的本機安裝器，供未來升級使用。

**版本包簽章不能保護已遭竄改的初始安裝腳本。** 如果每次都從遭入侵的
發布帳號下載 shell 並直接執行，惡意腳本可以跳過所有驗證。安裝器本身也
必須透過獨立的可信任管道分發或核對；單靠 TLS 的 `curl | sh` 仍然是在
信任下載的腳本。

更換金鑰時，先以原信任根或其他獨立可信任管道核對新指紋，明確更新本機
公鑰，再切換發布金鑰，不可自動相信版本包內的新公鑰。簽章保證內容真實，
不保證版本最新；明確指定較舊的已簽章版本仍可安裝。
