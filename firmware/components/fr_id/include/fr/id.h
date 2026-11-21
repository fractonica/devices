// Device identity (spec 06 §6.3): factory MAC plus the hub-assigned addr/alias/net stored in the
// read-only `fr_ident` NVS partition. Without that partition the device is UNASSIGNED (addr 0xFFFE).
// Also the node's other persistent link settings, so every NVS layout lives here: the network part of
// fr_ident (fr_net namespace), the RW overrides in the default `nvs` partition (fr_ovr alias, fr_net2
// pushed Wi-Fi, fr_hubs pushed hub list, fr_link pinned AP) and the boot epoch (fr_boot).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FR_ADDR_UNASSIGNED 0xFFFE
#define FR_ID_ALIAS_MAX 31
#define FR_ID_SSID_MAX 32  // 802.11 SSID
#define FR_ID_PASS_MAX 64  // WPA passphrase (8-63) or 64 hex digits
#define FR_ID_HOST_MAX 63
#define FR_ID_HUBS_MAX 4     // fr.node.hubs_set (design multi-hub-m1)
#define FR_ID_HUB_IP_MAX 15  // a dotted IPv4

typedef enum {
    FR_ID_UNASSIGNED = 0,
    FR_ID_PROVISIONED = 1,
    FR_ID_MISBOUND = 2,  // fr_ident belongs to another MAC (image copied between boards)
} fr_id_state_t;

typedef struct {
    uint8_t mac[6];
    char device_id[13];  // 12 lowercase hex digits of the factory MAC
    fr_id_state_t state;
    uint16_t addr;
    uint16_t net;
    char alias[FR_ID_ALIAS_MAX + 1];
    uint32_t alias_rev;
    uint16_t epoch_floor;
    uint16_t epoch;    // this boot's epoch; 0 until fr_id_commit_boot_epoch()
    char board[32];    // compiled in (CONFIG_FR_BOARD)
    char profile[32];  // compiled in (CONFIG_FR_PROFILE)
} fr_identity_t;

/** Wi-Fi credentials and hub host, as fr_ident or a `fr.node.net_set` carries them. `pass` is a secret:
 * nothing may log or print it. Strings are NUL-terminated; an empty ssid means "none". */
typedef struct {
    char ssid[FR_ID_SSID_MAX + 1];
    char pass[FR_ID_PASS_MAX + 1];
    bool has_bssid;
    uint8_t bssid[6];
    char hub_host[FR_ID_HOST_MAX + 1];  // `lab-mac.local`; empty: none (an override then keeps fr_ident's)
} fr_net_creds_t;

/** The fr_net namespace of fr_ident (06 §6.3), plus the fr_id `prov_ts` of the provisioning that wrote it. */
typedef struct {
    fr_net_creds_t creds;
    char country[4];   // ISO code (`LV`); empty: the driver default
    char hub_ip[16];   // dotted IPv4 fallback for hub_host; empty: none
    uint8_t band;      // `band` (design csi-c1 D6): 0 auto (also when absent), 1 2g, 2 5g
    uint32_t prov_ts;  // 0 when fr_ident carries none
} fr_net_config_t;

/** RW `nvs:fr_net2`: Wi-Fi pushed by fr.node.net_set (06 §6.3). */
typedef struct {
    fr_net_creds_t creds;
    /** fr_net_config_t.prov_ts when it was pushed. A later provisioning (another prov_ts) supersedes it,
     * since a reflash writes fr_ident but leaves the RW partition alone. */
    uint32_t base_prov_ts;
    /** Associated and got an address with it once. Only an unconfirmed (trial) override is reverted. */
    bool confirmed;
} fr_net_override_t;

/** One hub of the list: its host name and a dotted IPv4 fallback (empty: none). NUL-terminated. */
typedef struct {
    char host[FR_ID_HOST_MAX + 1];
    char ip[FR_ID_HUB_IP_MAX + 1];
} fr_hub_t;

/**
 * RW `nvs:fr_hubs`: the hub list pushed by fr.node.hubs_set (06 §6.3, design multi-hub-m1), in priority order. It
 * is written once a hub of the list has WELCOMEd the board, never while the list is on trial, so a reboot during a
 * trial returns to the list before it. count 0 is a stored "no list": its rev still stands.
 */
typedef struct {
    uint8_t count;
    fr_hub_t hubs[FR_ID_HUBS_MAX];
    /** Only grows: a push with a rev at or below it is refused. */
    uint32_t rev;
    /** fr_net_config_t.prov_ts when it was pushed; another prov_ts (a reprovision) supersedes the list. */
    uint32_t base_prov_ts;
} fr_hub_list_t;

/** RW `nvs:fr_link`: the AP of the last association (05 §5.4), for the pinned channel-C reconnect. */
typedef struct {
    uint8_t channel;
    uint8_t bssid[6];
    /** FNV-1a 32 of the SSID it was associated under: a pin left by another network is not used. */
    uint32_t ssid_hash;
} fr_link_pin_t;

/** Factory MAC (6 bytes). Never use esp_efuse_mac_get_default(): it returns 8 bytes on the C6. */
esp_err_t fr_id_get_mac(uint8_t out[6]);

/**
 * Loads identity; a missing or empty fr_ident is not an error (state = UNASSIGNED). The alias of
 * `nvs:fr_ovr` replaces fr_ident's when its alias_rev is higher (06 §6.3: the highest alias_rev wins).
 */
esp_err_t fr_id_load(fr_identity_t *out);

const char *fr_id_state_name(fr_id_state_t state);

/**
 * Boot epoch (spec 05 §5.5, 03 §3.5 step 1): max(stored, epoch_floor) + 1, the max taken in RFC 1982
 * serial order as receivers compare epochs (epoch_floor + 1 when nothing is stored, as after an NVS
 * erase), committed to the RW `nvs` partition (namespace fr_boot) and
 * then set in id->epoch. Call once per boot, after nvs_flash_init() and fr_id_load(), before anything
 * transmits. On an NVS error id->epoch is set all the same and the error is returned: the next boot
 * may then repeat this epoch.
 */
esp_err_t fr_id_commit_boot_epoch(fr_identity_t *id);

/**
 * fr.node.set_alias (06 §6.3 renames): stores alias + rev in `nvs:fr_ovr` and updates `id`. The hub's
 * registry wins, so any rev is taken; the same alias and rev again writes nothing. ESP_ERR_INVALID_ARG
 * for an alias that is not an RFC 1123 label of 1-31 characters.
 */
esp_err_t fr_id_set_alias(fr_identity_t *id, const char *alias, uint32_t rev);

/** Whether `alias` is an RFC 1123 label of 1-31 characters (lowercase letters, digits, inner '-'). */
bool fr_id_alias_valid(const char *alias, uint32_t len);

/** The fr_net namespace of fr_ident; call after fr_id_load(). ESP_ERR_NOT_FOUND when there is none. */
esp_err_t fr_id_load_net(fr_net_config_t *out);

/** `nvs:fr_net2`; ESP_ERR_NOT_FOUND when there is none (or it is unreadable). */
esp_err_t fr_id_load_net_override(fr_net_override_t *out);
esp_err_t fr_id_save_net_override(const fr_net_override_t *o);
esp_err_t fr_id_clear_net_override(void);

/** `nvs:fr_hubs`; ESP_ERR_NOT_FOUND when there is none (or it is unreadable: a list is whole or absent). */
esp_err_t fr_id_load_hubs(fr_hub_list_t *out);
esp_err_t fr_id_save_hubs(const fr_hub_list_t *list);
esp_err_t fr_id_clear_hubs(void);

/** `nvs:fr_link`; ESP_ERR_NOT_FOUND when nothing is pinned yet. */
esp_err_t fr_id_load_link(fr_link_pin_t *out);
esp_err_t fr_id_save_link(const fr_link_pin_t *pin);

/** FNV-1a 32 of an SSID, as fr_link_pin_t.ssid_hash holds it. */
uint32_t fr_id_ssid_hash(const char *ssid);

#ifdef __cplusplus
}
#endif
