use serde::Serialize;

/// 本机运行时环境检测结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// .NET Framework 4.x 是否可用
    pub dotnet_available: bool,
    pub dotnet_release: Option<u32>,
    pub dotnet_version: Option<String>,
    /// 面向用户的可读描述
    pub dotnet_display: String,
}

#[cfg(windows)]
pub fn detect() -> RuntimeStatus {
    let (release, version) = read_ndp_v4().unwrap_or((None, None));
    let available = release.is_some() || version.is_some();

    let display = match (&release, &version) {
        (Some(r), Some(v)) => format!(".NET Framework {v}（Release {r}）"),
        (Some(r), None) => format!(".NET Framework 4.x（Release {r}）"),
        (None, Some(v)) => format!(".NET Framework {v}"),
        (None, None) => "未检测到 .NET Framework 4.x".to_string(),
    };

    RuntimeStatus {
        dotnet_available: available,
        dotnet_release: release,
        dotnet_version: version,
        dotnet_display: display,
    }
}

#[cfg(not(windows))]
pub fn detect() -> RuntimeStatus {
    RuntimeStatus {
        dotnet_available: false,
        dotnet_release: None,
        dotnet_version: None,
        dotnet_display: "仅支持在 Windows 上检测".to_string(),
    }
}

/// 读取注册表 `HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full`
#[cfg(windows)]
fn read_ndp_v4() -> Option<(Option<u32>, Option<String>)> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full\0"
        .encode_utf16()
        .collect();

    let mut hkey: HKEY = std::ptr::null_mut();
    let rc = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.as_ptr(), 0, KEY_READ, &mut hkey) };
    if rc != 0 {
        return None;
    }

    let release = query_dword(hkey, "Release");
    let version = query_string(hkey, "Version");

    unsafe { RegCloseKey(hkey) };

    if release.is_none() && version.is_none() {
        return None;
    }
    Some((release, version))
}

#[cfg(windows)]
fn query_dword(hkey: windows_sys::Win32::System::Registry::HKEY, name: &str) -> Option<u32> {
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_DWORD};

    let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut value_type: u32 = 0;
    let mut size: u32 = 4;
    let mut data: u32 = 0;

    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            &mut data as *mut u32 as *mut u8,
            &mut size,
        )
    };
    if rc == 0 && value_type == REG_DWORD {
        Some(data)
    } else {
        None
    }
}

#[cfg(windows)]
fn query_string(hkey: windows_sys::Win32::System::Registry::HKEY, name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_SZ};

    let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut value_type: u32 = 0;
    let mut size: u32 = 0;

    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if rc != 0 || value_type != REG_SZ || size == 0 {
        return None;
    }

    let mut buffer = vec![0u8; size as usize];
    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            buffer.as_mut_ptr(),
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }

    let wide: Vec<u16> = buffer
        .chunks_exact(2)
        .map(|c| u16::from_ne_bytes([c[0], c[1]]))
        .collect();
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    let text = String::from_utf16_lossy(&wide[..end]).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
