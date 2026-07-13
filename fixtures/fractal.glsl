void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec3 ro = vec3(0.0, 0.6, 0.0);
    vec3 rd = vec3(uv, 1.0);

    float totalDist = 0.0;
    vec3 color = vec3(0.0);

    for (int i = 0; i < 100; i++)
    {
        vec3 p = ro + rd * totalDist;

        float cosT = cos(iTime);
        float sinT = sin(iTime);
        p.xz *= mat2(cosT, -sinT, sinT, cosT);

        float mapDist = 3.0;
        float scale = 0.7;
        float v = 3.0;

        vec3 w = p / 3.0;

        for (int j = 0; j < 9; j++)
        {
            p.xz = abs(p.xz) - 0.4;
            float dBox = max(length(p.xz), p.y = 2.0 - p.y);
            mapDist = min(mapDist, dBox / v);

            w.y -= 2.5;
            float k = min(dot(w, w), 0.5) + 0.02;
            scale /= k;
            w = abs(w) / k - 0.4;

            float u = dot(p, p);
            v /= u;
            p /= u;
        }

        mapDist = min(mapDist, (w.x + w.z) / scale);

        totalDist += mapDist;
        color += 0.01 / exp(mapDist * scale);
    }

    fragColor = vec4(color, 1.0);
}
