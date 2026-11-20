package com.fablepavilion.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Pattern;

final class SiteLogin {
    private static final Pattern INVITATION = Pattern.compile(
            "invite=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[A-Za-z0-9_-]{43}");

    private SiteLogin() {}

    static URI invitation(String input) {
        URI url = https(input);
        return url != null && "/".equals(url.getRawPath()) && "page=login-invite".equals(url.getRawQuery())
                && url.getRawFragment() != null && INVITATION.matcher(url.getRawFragment()).matches()
                ? url : null;
    }

    static URI storedOrigin(String input) {
        URI url = https(input);
        return url != null && url.getRawPath().isEmpty() && url.getRawQuery() == null
                && url.getRawFragment() == null ? origin(url) : null;
    }

    static URI origin(URI url) {
        try {
            int port = url.getPort();
            return new URI("https", null, url.getHost(), port == 443 ? -1 : port, null, null, null).normalize();
        } catch (URISyntaxException invalid) {
            throw new IllegalArgumentException("Invalid login origin", invalid);
        }
    }

    private static URI https(String input) {
        if (input == null || input.length() > 2048) return null;
        try {
            URI url = new URI(input);
            int port = url.getPort();
            return "https".equals(url.getScheme()) && url.getHost() != null && url.getRawUserInfo() == null
                    && (port == -1 || (port > 0 && port <= 65535)) ? url : null;
        } catch (URISyntaxException invalid) {
            return null;
        }
    }
}
