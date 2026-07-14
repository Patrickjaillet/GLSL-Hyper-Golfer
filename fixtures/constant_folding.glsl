void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    int a = 2 * 3;
    int b = 2 * 3 * 4;
    int c = 7 / 2;
    int d = 7 % 3;
    int e = 2 + 3 * 4;
    int f = 5 / 0;
    int g = 2000000000 * 3;
    int h = 0xFF * 2;
    float x = 2.0 * 3.0;

    int arr[2 * 3];
    for (int i = 0; i < 3 * 4; i++)
    {
        a += i;
    }

    int j = 1 + 2;
    int k = 1 + 2 + 3;
    int l = 3 - 5;
    int m = 3 - 5 + 10;
    int n = -5 + 3;
    int o = a - 1 + 2;
    int p = 2147483647 + 1;
    int q = -1 - 2 * 3;

    fragColor = vec4(float(a + b + c + d + e + f + g + h + j + k + l + m + n + o + p + q) + x, 0.0, 0.0, 1.0);
}
