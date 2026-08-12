const KEYRING_SERVICE: &str = "com.relaydeck.client.gateway";

fn validate_profile(profile: &str) -> Result<(), String> {
    if profile.is_empty()
        || profile.len() > 128
        || !profile
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("无效的连接配置标识".to_string());
    }
    Ok(())
}

fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.len() < 32 || secret.len() > 512 {
        return Err("网关访问令牌长度必须为 32-512 个字符".to_string());
    }
    Ok(())
}

fn entry(profile: &str) -> Result<keyring::Entry, String> {
    validate_profile(profile)?;
    keyring::Entry::new(KEYRING_SERVICE, profile)
        .map_err(|error| format!("无法访问系统凭据存储：{error}"))
}

#[tauri::command]
async fn get_gateway_secret(profile: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&profile)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取网关凭据：{error}")),
    })
    .await
    .map_err(|error| format!("凭据读取任务失败：{error}"))?
}

#[tauri::command]
async fn set_gateway_secret(profile: String, secret: String) -> Result<(), String> {
    validate_secret(&secret)?;
    tauri::async_runtime::spawn_blocking(move || {
        entry(&profile)?
            .set_password(&secret)
            .map_err(|error| format!("无法保存网关凭据：{error}"))
    })
    .await
    .map_err(|error| format!("凭据保存任务失败：{error}"))?
}

#[tauri::command]
async fn delete_gateway_secret(profile: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除网关凭据：{error}")),
    })
    .await
    .map_err(|error| format!("凭据删除任务失败：{error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_gateway_secret,
            set_gateway_secret,
            delete_gateway_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running Relaydeck");
}

#[cfg(test)]
mod tests {
    use super::{validate_profile, validate_secret};

    #[test]
    fn validates_credential_profile_identifiers() {
        assert!(validate_profile("default").is_ok());
        assert!(validate_profile("office-mac_01").is_ok());
        assert!(validate_profile("").is_err());
        assert!(validate_profile("../../other").is_err());
        assert!(validate_profile(&"a".repeat(129)).is_err());
    }

    #[test]
    fn validates_gateway_secret_lengths() {
        assert!(validate_secret(&"a".repeat(31)).is_err());
        assert!(validate_secret(&"a".repeat(32)).is_ok());
        assert!(validate_secret(&"a".repeat(512)).is_ok());
        assert!(validate_secret(&"a".repeat(513)).is_err());
    }
}
