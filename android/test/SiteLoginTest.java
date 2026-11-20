package com.fablepavilion.app;

import java.net.URI;

public final class SiteLoginTest {
    private static final String INVITE = "/?page=login-invite#invite=01234567-0123-4123-8123-0123456789ab."
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private static void require(boolean result) {
        if (!result) throw new AssertionError("Unexpected Android login-site decision");
    }

    public static void main(String[] args) {
        URI login = SiteLogin.invitation("https://agent.example.com" + INVITE);
        require(login != null && login.getRawFragment().startsWith("invite="));
        require(SiteLogin.origin(login).toString().equals("https://agent.example.com"));
        require(SiteLogin.origin(SiteLogin.invitation("https://self-hosted.example:8443" + INVITE))
                .toString().equals("https://self-hosted.example:8443"));
        require(SiteLogin.storedOrigin("https://agent.example.com:443").toString().equals("https://agent.example.com"));
        require(SiteLogin.storedOrigin(login.toString()) == null);
        require(SiteLogin.invitation("http://agent.example.com" + INVITE) == null);
        require(SiteLogin.invitation("https://user@agent.example.com" + INVITE) == null);
        require(SiteLogin.invitation("https://agent.example.com:65536" + INVITE) == null);
        require(SiteLogin.invitation("https://agent.example.com/path" + INVITE) == null);
        require(SiteLogin.invitation("https://agent.example.com" + INVITE + "&extra=1") == null);
        require(SiteLogin.invitation("https://agent.example.com" + INVITE.replace("page=", "extra=1&page=")) == null);
    }
}
