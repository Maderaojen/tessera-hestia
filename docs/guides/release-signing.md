# 後端發布簽章

- 更新：2026-10-22
- 英文版：[release-signing.en.md](release-signing.en.md)

後端版本包用 RSA／SHA-256 簽署 `SHA256SUMS`，安裝器先驗證
`SHA256SUMS.sig`，才相信 checksum、解壓或執行程式。沒有未簽章備援：
沒有簽章、或簽章驗不過的版本，安裝器一律停止。手機 App 更新金鑰是不同的
信任用途，不共用。

## 發布公鑰

目前的發布公鑰（RSA 3072）的 SHA-256 指紋（DER 格式）：

```
63decd33da1896e188725c3264e0778b7bcaf32c2d52b3e1ff1b81dfa757084a
```

公鑰寫在 `install.sh` 裡（`EMBEDDED_RELEASE_PUBLIC_KEY`）。安裝器依序使用：

1. `HESTIA_RELEASE_PUBLIC_KEY` 指定的檔案；
2. `$HESTIA_HOME/release-public.pem`（預設 `~/.local/share/hestia/release-public.pem`），
   有這個檔案時；和 `install.sh` 內建的不同時會印一行說明；
3. `install.sh` 內建的公鑰。第一次安裝、本機還沒有公鑰檔時，驗證通過後把它
   存成 `$HESTIA_HOME/release-public.pem`（權限 644，資料夾只有本人可寫），
   之後的升級以這個檔案為準。升級不會改動它。

## 一行安裝信任的是什麼

一行安裝（`curl -fsSL …/install.sh | sh`）的信任根是**經 HTTPS 從 GitHub
下載的 `install.sh`**，連同寫在裡面的公鑰。GitHub 帳號或 repo 被入侵時，
攻擊者可以同時改掉安裝器與公鑰，或讓安裝器跳過所有驗證；版本包的簽章擋不住
這種情況。發布用的私鑰也存在 GitHub Actions 的 secrets 裡（見「維護者」），
所以維護者的 GitHub 帳號被入侵時，攻擊者也可能發出簽章正確的版本。

簽章擋得住的是：

- 只換掉 Release 附件或鏡像（`HESTIA_DOWNLOAD_BASE`）上的版本包或 `SHA256SUMS`；
- 用已經存好公鑰的安裝器升級：本機的公鑰檔、或你保留下來的安裝器，都不會因為
  新的 Release 換了公鑰就跟著相信新的。

要更強的保證，不要直接把下載的腳本交給 `sh`：

- 先下載 `install.sh`，看過內容，再用另一個管道（例如已經安裝過的機器上的
  `~/.local/share/hestia/release-public.pem`、你信任的人）核對其中公鑰的指紋：

  ```bash
  sed -n '/-----BEGIN PUBLIC KEY-----/,/-----END PUBLIC KEY-----/p' install.sh \
    | sed "s/^EMBEDDED_RELEASE_PUBLIC_KEY='//; s/'\$//" \
    | openssl pkey -pubin -outform DER | openssl dgst -sha256
  ```

- 或自己放公鑰檔：核對過指紋的公鑰放在 `$HESTIA_HOME/release-public.pem`，或用
  `HESTIA_RELEASE_PUBLIC_KEY` 指定。
- 保留一份核對過的安裝器，之後用它升級（`HESTIA_VERSION=vX.Y.Z sh install.sh`）。

簽章保證內容真實，不保證版本最新：明確指定較舊的已簽章版本仍可安裝。

## 更換金鑰

新公鑰寫進 `install.sh` 的 `EMBEDDED_RELEASE_PUBLIC_KEY`，和第一個用新私鑰
簽章的版本同一個 commit；這份文件的指紋一起改。

已經安裝過的機器不會自動相信新公鑰：先用原本的信任根或其他獨立的管道核對
新指紋，明確更新本機的 `release-public.pem`（或 `HESTIA_RELEASE_PUBLIC_KEY`），
再升級。不要自動相信版本包或 Release 裡附帶的新公鑰。

## 維護者：簽章與發布

- 私鑰是 RSA 3072（`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`），
  放在 repo 外、只有本人可讀，另外安全備份；永遠不隨版本發布。
- 發布時設定 `HESTIA_RELEASE_SIGNING_KEY`（私鑰）與 `HESTIA_RELEASE_PUBLIC_KEY`
  （公鑰）。發布腳本在動到任何東西之前確認：兩個都有、公私鑰相符，而且要發布的
  commit 裡 `install.sh` 內建的公鑰就是這一把（不然發出去的安裝器驗不過自己的
  Release）；任何一項不符就停止。
- 發布腳本把公鑰指紋與一行安裝寫進 Release 說明。
- 發布通常在 GitHub Actions 進行：私鑰同時存在原始碼 repo（私有）的 Actions
  secrets，只在簽章那一步寫成暫存檔、做完刪除；簽章用的公鑰直接從要發布的
  commit 的 `install.sh` 取出。所以除了這個 repo，維護者的 GitHub 帳號也是信任
  的一部分（兩步驟驗證、只給單一 repo 的 token）。維護者自己的電腦上也留一份，
  在 Actions 不能用時從本機發布。
- 沒有設定金鑰的 dry run 只供檢視，產物沒有簽章，安裝器不會接受。
